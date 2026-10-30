import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCurl, shellSplit } from '../src/input/curl.ts';
import { analyzePath, buildEndpoint, deriveName } from '../src/input/endpoint.ts';
import { inferModels, unwrapEnvelope } from '../src/input/infer.ts';
import { camel, kebab, pascal, singular, snake } from '../src/input/naming.ts';
import { detectPaste } from '../src/input/paste.ts';

describe('naming', () => {
  it('converts cases', () => {
    assert.equal(camel('total_price'), 'totalPrice');
    assert.equal(pascal('order-item'), 'OrderItem');
    assert.equal(snake('OrderItemModel'), 'order_item_model');
    assert.equal(kebab('CreateUserRequest'), 'create-user-request');
  });
  it('singularizes common API nouns', () => {
    for (const [p, s] of [['users', 'user'], ['categories', 'category'], ['addresses', 'address'], ['boxes', 'box'], ['status', 'status'], ['people', 'person'], ['matches', 'match']]) {
      assert.equal(singular(p), s, p);
    }
  });
});

describe('shellSplit and parseCurl', () => {
  it('handles quotes, escapes and line continuations', () => {
    assert.deepEqual(shellSplit(`curl -H 'A: b c' \\\n  "x\\"y" $'line\\n'`), ['curl', '-H', 'A: b c', 'x"y', 'line\n']);
  });
  it('removes secrets and keeps the endpoint', () => {
    const r = parseCurl(`curl 'https://api.x.com/v1/items?token=abc&page=2' -H 'Authorization: Bearer t' -H 'Cookie: s=1' -H 'X-Trace: 1' -u me:pw`);
    assert.equal(r.method, 'GET');
    assert.equal(r.url.toString(), 'https://api.x.com/v1/items?page=2');
    assert.deepEqual(r.removedSecrets.sort(), ['basic auth credentials (-u)', 'header "Authorization"', 'header "Cookie"', 'query parameter "token"'].sort());
    assert.deepEqual(r.ignoredHeaders, ['X-Trace']);
  });
  it('infers POST from a body and honours -X and -G', () => {
    assert.equal(parseCurl(`curl https://a.io/x -d '{"a":1}'`).method, 'POST');
    assert.equal(parseCurl(`curl -X PUT https://a.io/x -d '{"a":1}'`).method, 'PUT');
    const g = parseCurl(`curl -G https://a.io/search -d q=lamp -d page=2`);
    assert.equal(g.method, 'GET');
    assert.equal(g.url.search, '?q=lamp&page=2');
    assert.equal(g.body, undefined);
  });
  it('supports --flag=value and --json', () => {
    const r = parseCurl(`curl --request=PATCH --url=https://a.io/u/1 --json '{"n":1}'`);
    assert.equal(r.method, 'PATCH');
    assert.equal(r.body, '{"n":1}');
  });
});

describe('detectPaste', () => {
  it('splits a cURL command from the JSON after it', () => {
    const p = detectPaste(`curl https://a.io/users/1 \\\n  -H 'Accept: application/json'\n\n{"id": 1}`);
    assert.match(p.curl!, /^curl https:\/\/a\.io\/users\/1/);
    assert.deepEqual(p.responseSamples, [{ id: 1 }]);
  });
  it('keeps a multi-line JSON body inside the cURL quotes', () => {
    const p = detectPaste(`curl https://a.io/x -d '{\n "a": 1\n}'\nresponse:\n{"ok": true}`);
    assert.match(p.curl!, /"a": 1/);
    assert.deepEqual(p.responseSamples, [{ ok: true }]);
  });
  it('reads labelled request and response blocks after a URL', () => {
    const p = detectPaste(`POST https://a.io/x\nrequest:\n{"a": 1}\nresponse:\n{"b": 2}`);
    assert.equal(p.url, 'POST https://a.io/x');
    assert.deepEqual(p.requestSample, { a: 1 });
    assert.deepEqual(p.responseSamples, [{ b: 2 }]);
  });
});

describe('inferModels', () => {
  it('merges samples: nullability, doubles, dates, nested models', () => {
    const r = inferModels(
      [
        { id: 1, price: 10, when: '2026-01-01T00:00:00Z', owner: { name: 'a' }, tags: ['x'] },
        { id: 2, price: 10, when: '2026-02-01', owner: { name: 'b' }, tags: [], extra: 'y' },
      ],
      'Thing',
    );
    assert.deepEqual(r.root, { kind: 'object', model: 'Thing' });
    const thing = r.models.find((m) => m.name === 'Thing')!;
    const f = Object.fromEntries(thing.fields.map((x) => [x.jsonName, x]));
    assert.equal(f.id.type.kind, 'int');
    assert.equal(f.price.type.kind, 'double', 'price is money, so double');
    assert.equal(f.when.type.kind, 'date');
    assert.deepEqual(f.owner.type, { kind: 'object', model: 'Owner' });
    assert.deepEqual(f.tags.type, { kind: 'array', item: { kind: 'string' } });
    assert.equal(f.extra.nullable, true, 'missing in one sample → nullable');
    assert.equal(r.models[0].name, 'Owner', 'dependencies come first');
  });
  it('flags unknowns instead of guessing', () => {
    const r = inferModels([{ a: null, b: [], c: 1 }, { a: null, b: [], c: 'x' }], 'X');
    const f = Object.fromEntries(r.models[0].fields.map((x) => [x.jsonName, x.type]));
    assert.equal(f.a.kind, 'unknown');
    assert.deepEqual(f.b, { kind: 'array', item: { kind: 'unknown' } });
    assert.equal(f.c.kind, 'unknown');
    assert.equal(r.warnings.length, 3);
  });
  it('reuses identical shapes and prefixes generic names', () => {
    const r = inferModels([{ billing: { city: 'a' }, shipping: { city: 'b' }, items: [{ sku: 'x' }] }], 'Order');
    const order = r.models.find((m) => m.name === 'Order')!;
    assert.deepEqual(order.fields.find((x) => x.jsonName === 'shipping')!.type, { kind: 'object', model: 'Billing' });
    assert.ok(r.models.some((m) => m.name === 'OrderItem'));
  });
  it('unwraps {data} envelopes only when every sample is one', () => {
    assert.deepEqual(unwrapEnvelope([{ data: { a: 1 }, meta: {} }]), [{ a: 1 }]);
    assert.equal(unwrapEnvelope([{ data: { a: 1 }, other: 1 }]), null);
    assert.equal(unwrapEnvelope([{ data: 'x' }]), null);
  });
});

describe('endpoint naming', () => {
  const name = (m: string, p: string) => deriveName(m as never, analyzePath(p)).name;
  it('derives function names from method and path', () => {
    assert.equal(name('GET', '/users/1'), 'getUser');
    assert.equal(name('GET', '/users'), 'getUsers');
    assert.equal(name('POST', '/users'), 'createUser');
    assert.equal(name('PATCH', '/users/1'), 'updateUser');
    assert.equal(name('DELETE', '/users/1'), 'deleteUser');
    assert.equal(name('GET', '/v1/users/1/orders'), 'getUserOrders');
    assert.equal(name('POST', '/users/3/activate'), 'activateUser');
  });
  it('names path parameters', () => {
    assert.equal(analyzePath('/users/42/orders/7').path, '/users/{userId}/orders/{id}');
    assert.equal(analyzePath('/teams/7f3e9d2a-1b4c-4e5f-8a9b-0c1d2e3f4a5b').params[0].type, 'string');
    assert.equal(analyzePath('/users/me').path, '/users/me');
    assert.equal(analyzePath('/users/me', '/users/{userId}').path, '/users/{userId}');
    assert.throws(() => analyzePath('/a/b', '/a'), /segments/);
  });
  it('builds a full spec with query params and a request model', () => {
    const s = buildEndpoint({ method: 'POST', url: new URL('https://a.io/users?notify=true'), body: '{"name":"x"}', responseSamples: [{ id: 1, name: 'x' }] });
    assert.equal(s.name, 'createUser');
    assert.deepEqual(s.queryParams, [{ name: 'notify', type: { kind: 'bool' } }]);
    assert.deepEqual(s.request, { kind: 'object', model: 'CreateUserRequest' });
    assert.deepEqual(s.response, { kind: 'object', model: 'User' });
  });
});
