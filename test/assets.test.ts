// codz assets: typed asset names per platform, kept in step with the files.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { planAssets } from '../src/skills/assets.ts';
import { cleanup, copyFixture } from './helpers.ts';

const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });
const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const put = (dir: string, ...files: string[]) => {
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), 'x');
  }
};

async function inFixture(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    await run(dir, ADAPTERS[id] as Adapter);
  } finally {
    cleanup(dir);
  }
}

describe('codz assets', () => {
  it('Flutter: a class per folder, fonts, pubspec folders; runs again cleanly; lists unused', () =>
    inFixture('flutter-riverpod', 'flutter', async (dir, a) => {
      await assert.rejects(planAssets(dir, a), /no assets\/ folder/);
      put(dir, 'assets/images/logo.png', 'assets/images/2.0x/logo.png', 'assets/icons/cart.png', 'assets/icons/cart.svg', 'assets/fonts/Inter-Regular.ttf', 'assets/fonts/Inter-Bold.ttf');
      const cs = await planAssets(dir, a);
      apply(dir, cs);
      const gen = read(dir, 'lib/gen/assets.dart');
      assert.match(gen, /abstract final class AppImages \{\n {2}static const logo = 'assets\/images\/logo\.png';\n\}/);
      assert.match(gen, /static const cartPng = 'assets\/icons\/cart\.png';/);
      assert.match(gen, /abstract final class AppFonts \{\n {2}static const inter = 'Inter';/);
      assert.doesNotMatch(gen, /2\.0x/);
      const pub = read(dir, 'pubspec.yaml');
      assert.match(pub, /\n {2}assets:\n {4}- assets\/icons\/\n {4}- assets\/images\/\n/);
      assert.match(pub, /- family: Inter\n {6}fonts:\n {8}- asset: assets\/fonts\/Inter-Bold\.ttf\n {10}weight: 700/);
      assert.match(cs.warnings.join('\n'), /Not used anywhere/);
      assert.equal((await planAssets(dir, a)).changes.length, 0, 'a second run changes nothing');
      rmSync(join(dir, 'assets/icons/cart.svg'));
      const again = await planAssets(dir, a);
      assert.ok(again.changes.some((c) => c.path === 'lib/gen/assets.dart'));
    }));

  it('Next.js: public/ paths', () =>
    inFixture('nextjs-helper', 'nextjs', async (dir, a) => {
      put(dir, 'public/images/logo.png', 'public/favicon.ico');
      apply(dir, await planAssets(dir, a));
      assert.match(read(dir, 'lib/assets.ts'), /export const publicFiles = \{\n {2}logo: '\/images\/logo\.png',\n\} as const;/);
    }));

  it('Android and iOS: already typed; Android resource names are checked', async () => {
    await inFixture('android-app', 'android', async (dir, a) => {
      put(dir, 'app/src/main/res/drawable/Bad-Name.png');
      const cs = await planAssets(dir, a);
      assert.equal(cs.changes.length, 0);
      assert.match(cs.warnings.join('\n'), /will break the build.*Bad-Name\.png/);
    });
    await inFixture('ios-swiftui', 'ios', async (dir, a) => {
      assert.match((await planAssets(dir, a)).summary.join('\n'), /Generate Asset Symbols/);
    });
  });
});
