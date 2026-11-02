// codz env add / list / use: named API environments in each platform's own way.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { createProject, type CreateOptions } from '../src/skills/create.ts';
import { listEnvs, planEnvAdd, planEnvUse } from '../src/skills/env.ts';
import { cleanup, copyFixture } from './helpers.ts';

const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

async function inFixture(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    await run(dir, ADAPTERS[id] as Adapter);
  } finally {
    cleanup(dir);
  }
}

describe('env', () => {
  it('checks names and URLs', () =>
    inFixture('nextjs-helper', 'nextjs', async (dir, a) => {
      await assert.rejects(planEnvAdd(dir, a, 'Staging', 'https://x.dev'), /not an environment name/);
      await assert.rejects(planEnvAdd(dir, a, 'default', 'https://x.dev'), /reserved/);
      await assert.rejects(planEnvAdd(dir, a, 'staging', 'ftp://x.dev'), /https:\/\//);
      await assert.rejects(planEnvAdd(dir, a, 'staging', 'https://me:secret@x.dev'), /user name or password/);
      await assert.rejects(planEnvAdd(dir, a, 'staging', undefined), /--base-url/);
    }));

  it('Next.js: .env.<name> and scripts with dotenv-cli; never .env.local', () =>
    inFixture('nextjs-helper', 'nextjs', async (dir, a) => {
      const cs = await planEnvAdd(dir, a, 'staging', 'https://staging.example.com/');
      assert.ok(cs.changes.every((c) => c.path !== '.env.local'));
      apply(dir, cs);
      assert.match(read(dir, '.env.staging'), /^NEXT_PUBLIC_API_URL=https:\/\/staging\.example\.com$/m);
      const pkg = JSON.parse(read(dir, 'package.json'));
      assert.equal(pkg.scripts['dev:staging'], 'dotenv -e .env.staging -- next dev');
      assert.ok(pkg.devDependencies['dotenv-cli']);
      await assert.rejects(planEnvAdd(dir, a, 'staging', 'https://other.example.com'), /already sets/);
      apply(dir, await planEnvAdd(dir, a, 'staging', 'https://other.example.com', { force: true }));
      const envs = await listEnvs(dir, a);
      assert.deepEqual(envs.find((e) => e.name === 'staging')?.baseUrl, 'https://other.example.com');
      const prod = await planEnvAdd(dir, a, 'production', 'https://api.example.com');
      assert.ok(!prod.changes.some((c) => c.path === 'package.json'), 'Next.js reads .env.production by itself');
      await assert.rejects(planEnvUse(dir, a, 'staging'), /chosen when you run the app/);
    }));

  it('Flutter: env/<name>.json and the Dio base URL from String.fromEnvironment', () =>
    inFixture('flutter-bloc-retrofit', 'flutter', async (dir, a) => {
      const cs = await planEnvAdd(dir, a, 'staging', 'https://staging.example.com');
      apply(dir, cs);
      assert.deepEqual(JSON.parse(read(dir, 'env/staging.json')), { API_BASE_URL: 'https://staging.example.com' });
      assert.match(read(dir, 'lib/di.dart'), /baseUrl: const String\.fromEnvironment\('API_BASE_URL', defaultValue: 'https:\/\/api\.taskboard\.dev\/v1'\)/);
      assert.match(read(dir, '.vscode/launch.json'), /--dart-define-from-file=env\/staging\.json/);
      apply(dir, await planEnvAdd(dir, a, 'qa', 'https://qa.example.com'));
      assert.equal((read(dir, 'lib/di.dart').match(/fromEnvironment/g) ?? []).length, 1, 'the Dio file changes once');
      assert.deepEqual((await listEnvs(dir, a)).map((e) => e.name).sort(), ['default', 'qa', 'staging']);
    }));

  it('Android, iOS and React Native CLI: a table in the code, and env use', async () => {
    const cases: [string, Partial<CreateOptions>, keyof typeof ADAPTERS, (dir: string) => void][] = [
      ['android', { architecture: 'retrofit-hilt' }, 'android', (dir) => {
        const g = read(dir, 'app/build.gradle.kts');
        assert.match(g, /val apiUrls = mapOf\(\n {4}"default" to "https:\/\/api\.example\.com\/v1\/",\n {4}"staging" to "https:\/\/staging\.example\.com\/",\n\)/);
        assert.match(g, /buildConfigField\("String", "BASE_URL", "\\"\$\{apiUrls\.getValue\(apiEnv\)\}\\""\)/);
        assert.match(g, /buildConfig = true/);
        assert.match(read(dir, 'gradle.properties'), /^apiEnv=staging$/m);
      }],
      ['ios', { architecture: 'urlsession' }, 'ios', (dir) => {
        const env = read(dir, 'ShopApp/Networking/AppEnvironment.swift');
        assert.match(env, /case staging\n/);
        assert.match(env, /case \.staging: return URL\(string: "https:\/\/staging\.example\.com"\)!/);
        assert.match(env, /static let fallback: AppEnvironment = \.staging/);
        assert.match(read(dir, 'ShopApp/Networking/APIClient.swift'), /AppEnvironment\.current\.baseURL/);
      }],
      ['react-native', { flavor: 'bare', architecture: 'axios' }, 'react-native', (dir) => {
        const env = read(dir, 'src/config/env.ts');
        assert.match(env, /staging: 'https:\/\/staging\.example\.com',/);
        assert.match(env, /export const APP_ENV: AppEnv = 'staging';/);
      }],
    ];
    for (const [type, extra, id, check] of cases) {
      const parent = mkdtempSync(join(tmpdir(), 'codz-env-'));
      try {
        const r = await createProject({ parent, name: type === 'ios' ? 'shop-app' : 'shop', type, baseUrl: type === 'react-native' ? 'https://api.example.com' : 'https://api.example.com/v1', org: 'com.acme', install: false, git: false, offline: true, ...extra } as CreateOptions);
        const dir = r.dir;
        const a = ADAPTERS[id] as Adapter;
        apply(dir, await planEnvAdd(dir, a, 'staging', 'https://staging.example.com'));
        apply(dir, await planEnvUse(dir, a, 'staging'));
        check(dir);
        assert.deepEqual((await listEnvs(dir, a)).map((e) => e.name), ['default', 'staging']);
        await assert.rejects(planEnvUse(dir, a, 'nope'), /No environment called nope/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  });
});
