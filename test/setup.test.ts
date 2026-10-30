// Setup on fresh projects: golden files for every architecture, then the
// first `api add` after setup, plus detection of the result.

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { stripJsonc } from '../src/adapters/nextjs.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planSetup } from '../src/skills/setup.ts';
import { cleanup, copyFixture, golden } from './helpers.ts';

const USER_CURL = `curl 'https://api.yourapp.com/users/42' -H 'Authorization: Bearer abc'
response:
{"id": 42, "name": "Pradeep", "email": "p@x.com", "created_at": "2026-10-22T10:00:00Z"}`;

async function setUp(fixture: string, adapter: Adapter, architecture: string, baseUrl = 'https://api.yourapp.com') {
  const dir = copyFixture(fixture);
  const { map } = await loadMap(dir, adapter, {});
  const { changeSet } = planSetup(dir, adapter, map, { architecture, baseUrl });
  return { dir, changeSet };
}

describe('setup (golden)', () => {
  const cases: [string, Adapter, string][] = [
    ['flutter-fresh', ADAPTERS.flutter, 'getx'],
    ['flutter-fresh', ADAPTERS.flutter, 'riverpod'],
    ['flutter-fresh', ADAPTERS.flutter, 'get_it'],
    ['nextjs-fresh', ADAPTERS.nextjs, 'fetch-helper'],
    ['nextjs-fresh', ADAPTERS.nextjs, 'plain-fetch'],
  ];
  for (const [fixture, adapter, arch] of cases) {
    it(`${fixture} → ${arch}, then a first api add`, async () => {
      const { dir, changeSet } = await setUp(fixture, adapter, arch);
      try {
        golden(`setup/${fixture}-${arch}/_summary.txt`, [...changeSet.summary.map((x) => `• ${x}`), ...changeSet.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
        for (const c of changeSet.changes) {
          // .env.local is checked inline: some tools refuse to copy files with that name.
          if (c.path === '.env.local') assert.equal(c.after, 'NEXT_PUBLIC_API_URL=https://api.yourapp.com\n');
          else golden(`setup/${fixture}-${arch}/${c.path}`, c.after ?? "");
        }

        // Apply, then add an endpoint: it must use the new layer with no manual step.
        applyChangeSet(dir, changeSet, { allowDirty: true, verify: false, format: false });
        const { changeSet: api } = await planApiAdd(dir, adapter, { paste: USER_CURL });
        golden(`setup/${fixture}-${arch}/after-api-add/_summary.txt`, [...api.summary.map((x) => `• ${x}`), ...api.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
        for (const c of api.changes) golden(`setup/${fixture}-${arch}/after-api-add/${c.path}`, c.after ?? "");
        assert.ok(!api.warnings.some((w) => /not registered|by hand/.test(w)), `no manual step expected: ${api.warnings.join(' | ')}`);
      } finally {
        cleanup(dir);
      }
    });
  }
});

describe('setup rules', () => {
  it('is offered only when there is no API layer', async () => {
    for (const [fixture, adapter] of [['flutter-riverpod', ADAPTERS.flutter], ['flutter-getit', ADAPTERS.flutter], ['nextjs-helper', ADAPTERS.nextjs], ['nextjs-plain', ADAPTERS.nextjs]] as const) {
      const dir = copyFixture(fixture);
      try {
        const { map } = await loadMap(dir, adapter, {});
        assert.deepEqual(adapter.architectures!(map), [], fixture);
      } finally {
        cleanup(dir);
      }
    }
  });

  it('recommends GetX when the project already depends on get', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const p = join(dir, 'pubspec.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace('  cupertino_icons: ^1.0.8', '  cupertino_icons: ^1.0.8\n  get: ^4.6.6'));
      const { map } = await loadMap(dir, ADAPTERS.flutter, {});
      const options = ADAPTERS.flutter.architectures!(map);
      assert.equal(options[0].id, 'getx');
      assert.equal(options[0].recommended, true);
      // An existing dependency is not added twice.
      const { changeSet } = planSetup(dir, ADAPTERS.flutter, map, { architecture: 'getx', baseUrl: '' });
      const pubspec = changeSet.changes.find((c) => c.path === 'pubspec.yaml')!.after!;
      assert.equal((pubspec.match(/^ {2}get:/gm) ?? []).length, 1);
      assert.match(pubspec, /^ {2}dio: \^5/m);
      assert.ok(changeSet.warnings.some((w) => w.includes('No base URL')));
    } finally {
      cleanup(dir);
    }
  });

  it('detects a GetX project it set up, even without the config file', async () => {
    const { dir, changeSet } = await setUp('flutter-fresh', ADAPTERS.flutter, 'getx');
    try {
      applyChangeSet(dir, changeSet, { allowDirty: true, verify: false, format: false });
      rmSync(join(dir, 'devtool.config.yaml'));
      const { map } = await loadMap(dir, ADAPTERS.flutter, {}, { force: true });
      assert.equal(map.conventions.di, 'getx');
      assert.equal(map.conventions.diFile, 'lib/app/bindings/initial_binding.dart');
      assert.equal(map.conventions.baseUrl, 'https://api.yourapp.com');
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to overwrite an existing file', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      writeFileSync(join(dir, 'lib/app_placeholder.dart'), '');
      const { map } = await loadMap(dir, ADAPTERS.flutter, {});
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'lib/core/network'), { recursive: true });
      writeFileSync(join(dir, 'lib/core/network/dio_provider.dart'), '// mine\n');
      assert.throws(() => planSetup(dir, ADAPTERS.flutter, map, { architecture: 'riverpod', baseUrl: 'https://a.io' }), /already exists/);
    } finally {
      cleanup(dir);
    }
  });

  it('rejects a base URL that is not a URL', async () => {
    const dir = copyFixture('nextjs-fresh');
    try {
      const { map } = await loadMap(dir, ADAPTERS.nextjs, {});
      assert.throws(() => planSetup(dir, ADAPTERS.nextjs, map, { architecture: 'fetch-helper', baseUrl: 'api.yourapp' }), /not a base URL/);
      // Quotes, backticks and $ would end up inside a string literal in the generated code.
      for (const bad of ["https://api.example.com/'+alert(1)+'", 'https://api.example.com/`${x}`', 'https://user:pw@api.example.com', 'javascript:alert(1)']) {
        assert.throws(() => planSetup(dir, ADAPTERS.nextjs, map, { architecture: 'fetch-helper', baseUrl: bad }), /not a base URL/, bad);
      }
    } finally {
      cleanup(dir);
    }
  });
});

describe('detection of common GetX-era styles', () => {
  it('reads models with a plain fromJson constructor and non-final fields', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'lib/app/data/models'), { recursive: true });
      writeFileSync(
        join(dir, 'lib/app/data/models/profile.dart'),
        `class Profile {\n  int? id;\n  String? fullName;\n  List<String>? tags;\n\n  Profile({this.id, this.fullName, this.tags});\n\n  Profile.fromJson(Map<String, dynamic> json) {\n    id = json['id'];\n    fullName = json['full_name'];\n  }\n\n  Map<String, dynamic> toJson() {\n    final data = <String, dynamic>{};\n    data['id'] = id;\n    return data;\n  }\n}\n`,
      );
      const { map } = await loadMap(dir, ADAPTERS.flutter, {});
      const profile = map.models.find((m) => m.name === 'Profile')!;
      assert.deepEqual(profile.fields.map((f) => `${f.name}:${f.type}${f.nullable ? '?' : ''}`), ['id:int?', 'full_name:String?', 'tags:List<String>?']);
      assert.equal(map.conventions.modelsFolder, 'lib/app/data/models');
    } finally {
      cleanup(dir);
    }
  });

  it('finds Dio fields declared with late, an initializer, or no final', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dir, 'lib/services'), { recursive: true });
      writeFileSync(join(dir, 'lib/services/api_service.dart'), `import 'package:dio/dio.dart';\n\nclass ApiService {\n  late final Dio dio = Dio();\n\n  Future<dynamic> getHome() async {\n    final r = await dio.get('/home');\n    return r.data;\n  }\n}\n`);
      const { map } = await loadMap(dir, ADAPTERS.flutter, {});
      assert.equal(map.conventions.repoFolder, 'lib/services');
      assert.equal(map.conventions.repoKind, 'service');
      assert.equal(map.conventions.dioField, 'dio');
      assert.equal(map.endpoints[0]?.path, '/home');
    } finally {
      cleanup(dir);
    }
  });
});

describe('tsconfig parsing', () => {
  it('keeps "/*" inside strings, removes real comments and trailing commas', () => {
    const t = `{ // c\n "compilerOptions": { /* x */ "paths": { "@/*": ["./*"] }, },\n "include": ["**/*.ts", "a//b"],\n}`;
    assert.deepEqual(JSON.parse(stripJsonc(t)), { compilerOptions: { paths: { '@/*': ['./*'] } }, include: ['**/*.ts', 'a//b'] });
  });
});
