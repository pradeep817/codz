// codz create: new projects, set up and ready for api add.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { loadConfig } from '../src/core/config.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { createProject, describeCreate, PROJECT_TYPES, type CreateOptions } from '../src/skills/create.ts';
import { INPUTS } from './helpers.ts';

function withParent(fn: (parent: string) => Promise<void>) {
  return async () => {
    const parent = mkdtempSync(join(tmpdir(), 'codz-create-'));
    try {
      await fn(parent);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  };
}

const base = (parent: string, o: Partial<CreateOptions>): CreateOptions => ({ type: 'flutter', name: 'shop_app', parent, architecture: 'riverpod', baseUrl: 'https://api.shop.dev/v1', org: 'com.acme', offline: true, install: false, git: false, ...o });

describe('codz create', () => {
  for (const t of PROJECT_TYPES) {
    for (const a of t.architectures) {
      it(`${t.label} + ${a.label}: created, configured, and api add works`, withParent(async (parent) => {
        const name = t.id === 'flutter' ? 'shop_app' : 'shop-app';
        const r = await createProject(base(parent, { type: t.id, name, architecture: a.id }));
        assert.equal(r.created, 'skeleton');
        assert.ok(existsSync(join(r.dir, 'codz.config.yaml')));
        assert.equal(loadConfig(r.dir).framework, t.framework);
        const { map } = await loadMap(r.dir, ADAPTERS[t.framework], loadConfig(r.dir).conventions);
        assert.equal(map.framework, t.framework);
        if (a.id === 'none') return;
        const { changeSet } = await planApiAdd(r.dir, ADAPTERS[t.framework], { url: 'https://api.shop.dev/v1/products', samples: [join(INPUTS, 'products.json')] });
        assert.ok(changeSet.changes.length >= 2, changeSet.summary.join('\n'));
        assert.deepEqual(changeSet.warnings.filter((w) => /not registered|Could not find/.test(w)), [], changeSet.warnings.join('\n'));
      }));
    }
  }

  it('Flutter: package name in pubspec and test, the architecture wired into main, a theme color', withParent(async (parent) => {
    const r = await createProject(base(parent, { architecture: 'bloc', primary: '#0F766E' }));
    assert.match(readFileSync(join(r.dir, 'pubspec.yaml'), 'utf8'), /^name: shop_app$/m);
    assert.match(readFileSync(join(r.dir, 'pubspec.yaml'), 'utf8'), /flutter_bloc:/);
    assert.match(readFileSync(join(r.dir, 'test/widget_test.dart'), 'utf8'), /package:shop_app\/main\.dart/);
    assert.match(readFileSync(join(r.dir, 'lib/main.dart'), 'utf8'), /setupDependencies\(\);/);
    assert.equal(loadConfig(r.dir).conventions.stateManagement, 'bloc');
    assert.ok(r.steps.some((s) => /primary color #0F766E/.test(s)));
    assert.ok(r.warnings.some((w) => /flutter create --org com\.acme --project-name shop_app \./.test(w)));
  }));

  it('Next.js: Tailwind, the fetch helper, the base URL, and a first git commit', withParent(async (parent) => {
    const r = await createProject(base(parent, { type: 'nextjs', name: 'web-shop', architecture: 'fetch-helper', baseUrl: 'https://api.shop.dev', tailwind: true, git: true }));
    assert.match(readFileSync(join(r.dir, 'package.json'), 'utf8'), /"tailwindcss"/);
    assert.match(readFileSync(join(r.dir, 'lib/api/client.ts'), 'utf8'), /export async function apiFetch/);
    assert.match(readFileSync(join(r.dir, '.env.example'), 'utf8'), /NEXT_PUBLIC_API_URL=https:\/\/api\.shop\.dev/);
    if (r.steps.includes('git init and a first commit')) {
      assert.ok(existsSync(join(r.dir, '.git')));
      assert.match(readFileSync(join(r.dir, '.gitignore'), 'utf8'), /\.codz\//);
    }
  }));

  it('refuses bad names, architectures, org ids, colors and non-empty folders', withParent(async (parent) => {
    await assert.rejects(createProject(base(parent, { name: 'Shop' })), /cannot be a Flutter project name/);
    await assert.rejects(createProject(base(parent, { name: 'class' })), /Dart keyword/);
    await assert.rejects(createProject(base(parent, { type: 'nextjs', name: 'Web App', architecture: 'none' })), /cannot be a Next\.js project name/);
    await assert.rejects(createProject(base(parent, { architecture: 'mvc' })), /Unknown architecture "mvc"/);
    await assert.rejects(createProject(base(parent, { org: 'acme' })), /not an organization id/);
    await assert.rejects(createProject(base(parent, { primary: 'teal' })), /not a #rrggbb color/);
    await createProject(base(parent, {}));
    await assert.rejects(createProject(base(parent, {})), /already exists and is not empty/);
  }));

  it('--dry-run describes the steps without touching the disk', withParent(async (parent) => {
    const steps = describeCreate(base(parent, { offline: false, install: true, git: true }));
    assert.match(steps[1], /flutter create --org com\.acme --project-name shop_app shop_app/);
    assert.ok(steps.some((s) => /Install dependencies \(flutter pub get\)/.test(s)));
    assert.equal(existsSync(join(parent, 'shop_app')), false);
  }));
});
