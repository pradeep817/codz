// Untrusted input (cURL, HAR, OpenAPI, JSON samples) must never become code
// in the generated project. These tests feed hostile values through the
// escaping helpers and through endpoint building.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBaseUrl, commentText, encodePathSegment, jsString, jsTemplateText, ktString } from '../src/core/safe.ts';
import { buildEndpoint } from '../src/input/endpoint.ts';
import { dartPathLiteral, dq } from '../src/adapters/dartGen.ts';

const HOSTILE = ["'", '"', '`', '${x}', '\\', '*/', '\n', '$y', ' '];

describe('safe: escaping for generated code', () => {
  it('JS strings and template text round-trip through eval without running anything', () => {
    for (const q of ["'", '"', '`']) {
      for (const h of HOSTILE) {
        const s = `a${h}b${h}`;
        // eslint-disable-next-line no-new-func
        assert.equal(new Function(`return ${jsString(s, q)};`)(), s, `${q} ${JSON.stringify(h)}`);
      }
    }
    for (const h of HOSTILE) {
      const s = `/x${h}`;
      // eslint-disable-next-line no-new-func
      assert.equal(new Function(`return \`${jsTemplateText(s)}\`;`)(), s);
    }
  });

  it('Kotlin and Dart literals escape quotes, backslashes and $', () => {
    assert.equal(ktString('a"b\\c$d'), '"a\\"b\\\\c\\$d"');
    assert.equal(dq("a'b\\c$d\n"), "'a\\'b\\\\c\\$d\\n'");
    assert.equal(dartPathLiteral("/a/{id}/b'$c"), "'/a/$id/b\\'\\$c'");
    assert.equal(dartPathLiteral('/a/{id}x'), "'/a/${id}x'");
  });

  it('comments cannot be closed early, and paths are percent-encoded', () => {
    assert.ok(!commentText('a */ b').includes('*/'));
    assert.equal(encodePathSegment("x'`$\"*(){} é"), 'x%27%60%24%22%2A%28%29%7B%7D%20%C3%A9');
    assert.equal(encodePathSegment('user-1.json'), 'user-1.json');
  });

  it('endpoint paths from a hostile URL hold no quote, backtick, $ or comment end', () => {
    const spec = buildEndpoint({ method: 'GET', url: new URL("https://api.example.com/items/1/a'\"`${x}*/evil()/*"), responseSamples: [] });
    assert.doesNotMatch(spec.path, /['"`$\\]|\*\//);
    assert.match(spec.path, /^\/items\/\{itemId\}\/a%27%22%60%24/);
  });

  it('hosts with quotes or backticks are refused; base URLs are checked strictly', () => {
    assert.throws(() => buildEndpoint({ method: 'GET', url: new URL('https://a`b.example.com/x'), responseSamples: [] }), /host/);
    assert.equal(checkBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
    for (const bad of ["https://api.example.com/'x", 'https://api.example.com/?q=1', 'ftp://api.example.com', 'https://a"b.com']) assert.throws(() => checkBaseUrl(bad), /not a base URL|host/, bad);
  });
});

describe('safe: the project boundary', () => {
  it('writes through a symbolic link that leaves the project are refused', async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildChangeSet } = await import('../src/core/changeset.ts');
    const root = mkdtempSync(join(tmpdir(), 'dt-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'dt-outside-'));
    try {
      mkdirSync(join(root, 'lib'));
      symlinkSync(outside, join(root, 'lib', 'api'));
      assert.throws(() => buildChangeSet(root, 'test', { files: new Map([['lib/api/users.ts', 'x']]), summary: [], warnings: [], generated: [] }), /symbolic link/);
      assert.doesNotThrow(() => buildChangeSet(root, 'test', { files: new Map([['lib/users.ts', 'x']]), summary: [], warnings: [], generated: [] }));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
