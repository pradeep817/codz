// codz locale extract: screen text into locale files, read back the project's way.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { planLocaleExtract } from '../src/skills/localeExtract.ts';
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

describe('locale extract', () => {
  it('next-intl: JSX text and attributes, t from useTranslations or getTranslations, shared text under common', () =>
    inFixture('nextjs-helper', 'nextjs', async (dir, a) => {
      mkdirSync(join(dir, 'app/catalog'), { recursive: true });
      mkdirSync(join(dir, 'components'), { recursive: true });
      writeFileSync(join(dir, 'app/catalog/page.tsx'), "export default async function CatalogPage() {\n  return (\n    <main>\n      <h1>Catalog</h1>\n      <p>Don't wait</p>\n      <button>Retry</button>\n    </main>\n  );\n}\n".replace(/^/, ''), { flag: 'w' });
      writeFileSync(join(dir, 'components/search.tsx'), "'use client';\n\nexport function Search({ onPick }: { onPick: (id: string) => void }) {\n  return (\n    <div>\n      <input placeholder=\"Search products\" />\n      <button onClick={() => onPick('x')}>Retry</button>\n    </div>\n  );\n}\n");
      const cs = await planLocaleExtract(dir, a, ['app/catalog/page.tsx', 'components/search.tsx']);
      apply(dir, cs);
      const page = read(dir, 'app/catalog/page.tsx');
      assert.match(page, /import \{ getTranslations \} from 'next-intl\/server';/);
      assert.match(page, /const t = await getTranslations\(\);/);
      assert.match(page, /<h1>\{t\('catalog\.catalog'\)\}<\/h1>/);
      assert.match(page, /<p>\{t\("catalog\.donTWait"\)\}<\/p>/);
      assert.match(page, /\{t\('common\.retry'\)\}/);
      const search = read(dir, 'components/search.tsx');
      assert.match(search, /^'use client';\nimport \{ useTranslations \} from 'next-intl';/);
      assert.match(search, /placeholder=\{t\('search\.searchProducts'\)\}/);
      const en = JSON.parse(read(dir, 'messages/en.json'));
      assert.equal(en.catalog.donTWait, "Don't wait");
      assert.equal(en.common.retry, 'Retry');
      assert.equal(JSON.parse(read(dir, 'messages/hi.json')).common.retry, 'Retry', 'other languages get the text until translated');
      // Running again finds nothing new.
      const again = await planLocaleExtract(dir, a, ['app/catalog/page.tsx']);
      assert.equal(again.changes.length, 0);
    }));

  it('Flutter ARB: AppLocalizations, placeholders, const removed, MaterialApp wired once', () =>
    inFixture('flutter-riverpod', 'flutter', async (dir, a) => {
      writeFileSync(
        join(dir, 'lib/features/home/greeting.dart'),
        "import 'package:flutter/material.dart';\n\nclass Greeting extends StatelessWidget {\n  const Greeting({super.key, required this.name});\n\n  final String name;\n\n  @override\n  Widget build(BuildContext context) {\n    return const Padding(\n      padding: EdgeInsets.all(8),\n      child: Text('Nothing here yet'),\n    );\n  }\n\n  Widget hello(BuildContext context) => Text('Hello $name');\n}\n",
      );
      const cs = await planLocaleExtract(dir, a, ['lib/features/home/greeting.dart']);
      apply(dir, cs);
      const g = read(dir, 'lib/features/home/greeting.dart');
      assert.match(g, /return Padding\(/, 'const removed from the enclosing constructor');
      assert.match(g, /child: Text\(AppLocalizations\.of\(context\)!\.greetingNothingHereYet\)/);
      assert.match(g, /Text\(AppLocalizations\.of\(context\)!\.greetingHello\(name\)\)/);
      assert.match(g, /import 'package:shop_app\/l10n\/app_localizations\.dart';/);
      const arb = JSON.parse(read(dir, 'lib/l10n/app_en.arb'));
      assert.equal(arb.greetingHello, 'Hello {name}');
      assert.ok(arb['@greetingHello'].placeholders.name);
      assert.match(read(dir, 'l10n.yaml'), /arb-dir: lib\/l10n/);
      assert.match(read(dir, 'pubspec.yaml'), /flutter_localizations:\n\s+sdk: flutter/);
      const main = read(dir, 'lib/main.dart');
      assert.match(main, /localizationsDelegates: AppLocalizations\.localizationsDelegates,/);
    }));

  it('GetX: .tr keys in the Translations class', () =>
    inFixture('flutter-getx-cli', 'flutter', async (dir, a) => {
      const views = (await planLocaleExtract(dir, a)).changes.map((c) => c.path);
      assert.ok(views.some((p) => p.endsWith('app_translations.dart')), `translations written: ${views.join(', ')}`);
    }));

  it('Compose: stringResource and strings.xml', () =>
    inFixture('android-app', 'android', async (dir, a) => {
      const f = 'app/src/main/java/dev/fieldops/app/ui/jobs/HelloScreen.kt';
      writeFileSync(join(dir, f), 'package dev.fieldops.app.ui.jobs\n\nimport androidx.compose.material3.Text\nimport androidx.compose.runtime.Composable\n\n@Composable\nfun HelloScreen(name: String) {\n    Text("It\'s ready")\n    Text("Hi $name")\n}\n');
      apply(dir, await planLocaleExtract(dir, a, [f]));
      const k = read(dir, f);
      assert.match(k, /Text\(stringResource\(R\.string\.hello_it_s_ready\)\)/);
      assert.match(k, /Text\(stringResource\(R\.string\.hello_hi, name\)\)/);
      assert.match(k, /import androidx\.compose\.ui\.res\.stringResource/);
      const xml = read(dir, 'app/src/main/res/values/strings.xml');
      assert.match(xml, /<string name="hello_it_s_ready">It\\'s ready<\/string>/);
      assert.match(xml, /<string name="hello_hi">Hi %1\$s<\/string>/);
    }));

  it('iOS: nothing to do, String Catalogs already collect Text literals', () =>
    inFixture('ios-swiftui', 'ios', async (dir, a) => {
      await assert.rejects(planLocaleExtract(dir, a), /String Catalog/);
    }));
});
