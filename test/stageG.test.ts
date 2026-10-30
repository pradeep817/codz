// feature add, auth add and api diff: whole features in one change, sign-in
// for an existing project, and breaking-change reports between two specs.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet, undoLast } from '../src/core/changeset.ts';
import { ToolError } from '../src/core/types.ts';
import { main } from '../src/cli.ts';
import { diffFails, diffSpecs, planApiDiff, renderDiffMarkdown, renderDiffSarif, renderDiffText } from '../src/skills/apiDiff.ts';
import { planAuthAdd } from '../src/skills/auth.ts';
import { planFeatureAdd, planScreens } from '../src/skills/feature.ts';
import { planApiImport } from '../src/skills/apiImport.ts';
import { cleanup, copyFixture, input, INPUTS, REPO } from './helpers.ts';

const SPEC = join(INPUTS, 'shop-openapi.yaml');
const SPEC2 = join(INPUTS, 'shop-openapi-v2.yaml');
const { nextjs, flutter, android } = ADAPTERS;
const rn = ADAPTERS['react-native'];

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
  try {
    return { code: await main([...args, '--no-color']), out };
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
}

const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });

describe('feature add', () => {
  it('orders screens so /x/new comes before /x/:id', () => {
    const picks = planScreens('users', [
      { name: 'getUser', method: 'GET', path: '/users/{userId}', params: ['userId'], list: false, body: false },
      { name: 'listUsers', method: 'GET', path: '/users', params: [], list: true, body: false },
      { name: 'createUser', method: 'POST', path: '/users', params: [], list: false, body: true },
    ] as Parameters<typeof planScreens>[1], true);
    assert.deepEqual(picks.map((p) => p.kind), ['list', 'create', 'detail']);
    assert.ok(picks.find((p) => p.kind === 'create')!.route.endsWith('/new'));
  });

  it('React Native: endpoints, list/detail/create screens, links and tests as one change; undo removes all of it', async () => {
    const dir = copyFixture('rn-app');
    try {
      const before = readFileSync(join(dir, 'src/navigation/RootNavigator.tsx'), 'utf8');
      const r = await planFeatureAdd(dir, rn, { name: 'users', spec: SPEC });
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail']);
      assert.ok(r.tests);
      const paths = r.changeSet.changes.map((c) => c.path);
      for (const p of ['src/api/users.ts', 'src/screens/UsersScreen.tsx', 'src/screens/UserDetailScreen.tsx', 'src/screens/NewUserScreen.tsx', 'src/api/users.test.ts']) assert.ok(paths.includes(p), `missing ${p}`);
      // Nothing written while planning.
      assert.equal(existsSync(join(dir, 'src/screens/UsersScreen.tsx')), false);
      assert.equal(readFileSync(join(dir, 'src/navigation/RootNavigator.tsx'), 'utf8'), before);
      const list = r.changeSet.changes.find((c) => c.path === 'src/screens/UsersScreen.tsx')!.after!;
      assert.match(list, /navigation\.navigate\('UserDetail', \{ userId: String\(item\.id\) \}\)/);
      assert.match(list, /title="New user"/);
      apply(dir, r.changeSet);
      assert.ok(existsSync(join(dir, 'src/screens/UsersScreen.tsx')));
      undoLast(dir, { force: true });
      assert.equal(existsSync(join(dir, 'src/screens/UsersScreen.tsx')), false);
      assert.equal(readFileSync(join(dir, 'src/navigation/RootNavigator.tsx'), 'utf8'), before);
    } finally {
      cleanup(dir);
    }
  });

  it('stops on a model clash unless --skip-conflicts', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      await assert.rejects(planFeatureAdd(dir, nextjs, { name: 'users', spec: SPEC }), (e: unknown) => e instanceof ToolError && /already has a model called User/.test(e.message + (e.hint ?? '')));
      const r = await planFeatureAdd(dir, nextjs, { name: 'users', spec: SPEC, skipConflicts: true });
      assert.ok(r.changeSet.changes.length > 0);
      assert.ok(r.changeSet.warnings.some((w) => /User/.test(w)));
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter (go_router + get_it) and Android (Compose + Hilt) link the list to detail and create', async () => {
    const f = copyFixture('flutter-bloc-retrofit');
    const a = copyFixture('android-app');
    try {
      const fr = await planFeatureAdd(f, flutter, { name: 'users', spec: SPEC, tests: false });
      const page = fr.changeSet.changes.find((c) => c.path === 'lib/features/users/users_page.dart')!.after!;
      assert.match(page, /onTap: \(\) => context\.push\('\/users\/\$\{items\[index\]\.id\}'\)/);
      assert.match(page, /floatingActionButton: FloatingActionButton\(/);
      assert.ok(!fr.changeSet.changes.some((c) => c.path.startsWith('test/')));
      const ar = await planFeatureAdd(a, android, { name: 'users', spec: SPEC });
      const nav = ar.changeSet.changes.find((c) => c.path.endsWith('FieldOpsNavHost.kt'))!.after!;
      assert.match(nav, /UsersScreen\(onOpen = \{ id -> navController\.navigate\("users\/\$id"\) \}, onNew = \{ navController\.navigate\("users\/new"\) \}\)/);
    } finally {
      cleanup(f);
      cleanup(a);
    }
  });

  it('rejects a bad name and a missing source', async () => {
    const dir = copyFixture('rn-app');
    try {
      await assert.rejects(planFeatureAdd(dir, rn, { name: '../x', spec: SPEC }), /not a feature name/);
      await assert.rejects(planFeatureAdd(dir, rn, { name: 'users' }), /Where do the endpoints come from/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('auth add', () => {
  it('Next.js: cookie session, server actions, login page and middleware', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await planAuthAdd(dir, nextjs, { publicPaths: ['/about'] });
      const files = new Map(r.changeSet.changes.map((c) => [c.path, c.after ?? '']));
      for (const p of ['lib/auth/cookie.ts', 'lib/auth/session.ts', 'lib/auth/actions.ts', 'app/login/page.tsx', 'middleware.ts']) assert.ok(files.has(p), `missing ${p}`);
      assert.ok([...files.values()].some((t) => /httpOnly: true/.test(t)));
      assert.match(files.get('middleware.ts')!, /'\/about'/);
      apply(dir, r.changeSet);
      await assert.rejects(planAuthAdd(dir, nextjs, {}), (e: unknown) => e instanceof ToolError && e.code === 'auth_exists');
    } finally {
      cleanup(dir);
    }
  });

  it('React Native: secure token store, token header in the fetch helper, AuthProvider around the app', async () => {
    const dir = copyFixture('rn-app');
    try {
      const r = await planAuthAdd(dir, rn, {});
      const files = new Map(r.changeSet.changes.map((c) => [c.path, c.after ?? '']));
      assert.ok(files.has('src/auth/tokenStore.ts'));
      assert.match(files.get('App.tsx')!, /<AuthProvider>/);
      assert.match(files.get('package.json')!, /expo-secure-store|react-native-keychain/);
      assert.match(files.get('src/api/client.ts')!, /Authorization/);
    } finally {
      cleanup(dir);
    }
  });

  it('says what to wire by hand when the network setup has an unknown shape', async () => {
    const a = copyFixture('android-app');
    const f = copyFixture('flutter-bloc-retrofit');
    try {
      const ar = await planAuthAdd(a, android, {});
      assert.ok(ar.changeSet.warnings.some((w) => /Add AuthInterceptor to your OkHttpClient/.test(w)));
      assert.ok(ar.changeSet.changes.some((c) => c.path.endsWith('data/auth/TokenStore.kt')));
      const fr = await planAuthAdd(f, flutter, {});
      assert.ok(fr.changeSet.warnings.some((w) => /attachAuth\(dio\)/.test(w)));
      assert.match(fr.changeSet.changes.find((c) => c.path === 'lib/router.dart')!.after!, /redirect:/);
    } finally {
      cleanup(a);
      cleanup(f);
    }
  });

  it('validates paths and field names', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      await assert.rejects(planAuthAdd(dir, nextjs, { loginPath: 'auth/login' }));
      await assert.rejects(planAuthAdd(dir, nextjs, { tokenField: 'a"b' }));
    } finally {
      cleanup(dir);
    }
  });
});

describe('api diff', () => {
  it('classifies changes between two specs', () => {
    const { report } = diffSpecs(input('shop-openapi.yaml'), input('shop-openapi-v2.yaml'));
    const has = (kind: string, at?: string) => report.changes.some((c) => c.kind === kind && (!at || c.at === at || c.operation === at));
    assert.ok(has('operation-removed', 'DELETE /v1/users/{userId}'));
    assert.ok(has('type-changed', 'response.id'));
    assert.ok(has('field-removed', 'response.avatar_url'));
    assert.ok(has('request-field-required', 'request.phone'));
    assert.ok(has('became-nullable', 'response.total'));
    assert.ok(has('query-removed', 'query.search'));
    assert.ok(has('query-added', 'query.limit'));
    assert.ok(has('field-added', 'response.nickname'));
    assert.equal(report.changes.find((c) => c.at === 'response.total')!.severity, 'warning');
    assert.deepEqual(report.counts, { breaking: 8, warning: 2, info: 7 });
    // Breaking first.
    assert.equal(report.changes[0].severity, 'breaking');
  });

  it('identical specs: no changes; --fail-on levels', () => {
    const same = diffSpecs(input('shop-openapi.yaml'), input('shop-openapi.yaml')).report;
    assert.equal(same.changes.length, 0);
    const r = { ...diffSpecs(input('shop-openapi.yaml'), input('shop-openapi-v2.yaml')).report, inProject: false };
    assert.equal(diffFails(r, 'breaking'), true);
    assert.equal(diffFails(r, 'none'), false);
    const onlyInfo = { ...r, changes: r.changes.filter((c) => c.severity === 'info'), counts: { breaking: 0, warning: 0, info: 7 } };
    assert.equal(diffFails(onlyInfo, 'breaking'), false);
    assert.equal(diffFails(onlyInfo, 'warning'), false);
    assert.equal(diffFails(onlyInfo, 'any'), true);
  });

  it('a field added as optional to a request is not breaking; a new required one is', () => {
    const base = input('shop-openapi.yaml');
    const optional = base.replace('        email: { type: string, format: email }', '        email: { type: string, format: email }\n        phone: { type: string }');
    const { report } = diffSpecs(base, optional);
    const phone = report.changes.find((c) => c.operation === 'POST /v1/users' && c.at === 'request.phone')!;
    assert.equal(phone.severity, 'info');
  });

  it('inside a project lists the lines that use each change', async () => {
    const dir = copyFixture('rn-app');
    try {
      apply(dir, (await planFeatureAdd(dir, rn, { name: 'users', spec: SPEC })).changeSet);
      const r = await planApiDiff(dir, rn, SPEC, SPEC2);
      assert.ok(r.inProject);
      const removed = r.changes.find((c) => c.kind === 'operation-removed')!;
      assert.equal(removed.endpoint, 'deleteUser');
      const avatar = r.changes.find((c) => c.operation === 'GET /v1/users/{userId}' && c.at === 'response.avatar_url')!;
      assert.ok(avatar.usages.some((u) => u.file === 'src/screens/UserDetailScreen.tsx'), JSON.stringify(avatar.usages));
      const md = renderDiffMarkdown(r);
      assert.match(md, /### API change: 8 breaking/);
      assert.match(md, /`src\/screens\/UserDetailScreen\.tsx:\d+`/);
      const sarif = JSON.parse(renderDiffSarif(r, dir));
      assert.equal(sarif.version, '2.1.0');
      const loc = sarif.runs[0].results.find((x: { locations?: unknown[] }) => x.locations)?.locations[0].physicalLocation;
      assert.ok(loc.region.startLine > 0 && !loc.artifactLocation.uri.startsWith('/'));
      assert.match(renderDiffText(r), /✗ DELETE \/v1\/users\/\{userId\} was removed {2}\[deleteUser\(\)\]/);
    } finally {
      cleanup(dir);
    }
  });

  it('CLI: exit code follows --fail-on, --report writes the file, works outside a project', async () => {
    const dir = copyFixture('rn-app');
    try {
      const outside = await cli(['api', 'diff', SPEC, SPEC2, '--cwd', INPUTS]);
      assert.equal(outside.code, 1);
      assert.match(outside.out, /8 breaking/);
      assert.equal((await cli(['api', 'diff', SPEC, SPEC2, '--fail-on', 'none', '--cwd', dir])).code, 0);
      const report = join(dir, 'api-diff.md');
      const r = await cli(['api', 'diff', SPEC, SPEC2, '--format', 'md', '--report', report, '--fail-on', 'none', '--cwd', dir]);
      assert.equal(r.code, 0);
      assert.match(readFileSync(report, 'utf8'), /#### Breaking/);
      const bad = await cli(['api', 'diff', SPEC, SPEC2, '--format', 'pdf', '--cwd', dir]);
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /--format must be/);
      writeFileSync(join(dir, 'empty.yaml'), 'openapi: 3.0.3\ninfo: { title: x, version: "1" }\npaths: {}\n');
      const missing = await cli(['api', 'diff', SPEC, join(dir, 'nope.yaml'), '--cwd', dir]);
      assert.notEqual(missing.code, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe('endpoints from a spec go relative to the client base URL', () => {
  // shop-openapi.yaml's server is https://api.yourapp.com/v1: a stand-in for the app's own base URL.
  const dioWith = (dir: string, options: string) => {
    const f = join(dir, 'lib/core/network/dio_provider.dart');
    writeFileSync(f, readFileSync(f, 'utf8').replace("Dio(BaseOptions(baseUrl: 'https://api.example.com'))", `Dio(BaseOptions(${options}))`));
  };
  const importGetOrder = async (dir: string, adapter: typeof flutter) => {
    const r = await planApiImport(dir, adapter, { file: SPEC, only: ['getOrder'] });
    return r.changeSet.changes.map((c) => c.after ?? '').join('\n');
  };

  it('Flutter: another host in Dio baseUrl keeps the path, never the spec host', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      dioWith(dir, "baseUrl: 'https://api.test.baseurl', connectTimeout: const Duration(seconds: 20)");
      const code = await importGetOrder(dir, flutter);
      assert.match(code, /_dio\.get<Map<String, dynamic>>\('\/v1\/orders\/\$orderId'\)/);
      assert.doesNotMatch(code, /https:\/\/api\.yourapp\.com/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter: a baseUrl that already ends in /v1 drops it from the path', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      dioWith(dir, "baseUrl: 'https://api.test.baseurl/v1/'");
      assert.match(await importGetOrder(dir, flutter), /\('\/orders\/\$orderId'\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter: a baseUrl devtool cannot read (a constant) still means a relative path', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      dioWith(dir, 'baseUrl: AppConfig.apiUrl');
      const code = await importGetOrder(dir, flutter);
      assert.match(code, /\('\/v1\/orders\/\$orderId'\)/);
      assert.doesNotMatch(code, /https:\/\//);
    } finally {
      cleanup(dir);
    }
  });

  it('Android and Next.js: no spec host in the call', async () => {
    const a = copyFixture('android-app');
    const n = copyFixture('nextjs-helper');
    try {
      const kt = await importGetOrder(a, android);
      assert.match(kt, /@GET\("orders\/\{orderId\}"\)/);
      assert.doesNotMatch(kt, /yourapp/);
      const r = await planApiImport(n, nextjs, { file: SPEC, only: ['getOrder'] });
      const ts = r.changeSet.changes.map((c) => c.after ?? '').join('\n');
      assert.match(ts, /\/v1\/orders\/\$\{/);
      assert.doesNotMatch(ts, /yourapp/);
      assert.ok(!r.changeSet.warnings.some((w) => /does not match any configured base URL/.test(w)));
    } finally {
      cleanup(a);
      cleanup(n);
    }
  });
});

describe('feature add sets up a fresh project first', () => {
  const EXAMPLE = join(REPO, 'examples', 'openapi.yaml');
  const text = (r: { changeSet: { changes: { path: string; after: string | null }[] } }, path: string) => r.changeSet.changes.find((c) => c.path === path)?.after ?? '';

  it('Flutter with no API layer: the recommended architecture, then 4 linked screens', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const r = await planFeatureAdd(dir, flutter, { name: 'products', spec: EXAMPLE });
      assert.equal(r.setup?.architecture, 'riverpod');
      assert.ok(r.setup?.dependenciesChanged);
      assert.ok(r.changeSet.summary.some((l) => /^Set up first: Riverpod, base URL https:\/\/api\.example\.com\/v1/.test(l)));
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail', 'edit']);
      const paths = r.changeSet.changes.map((c) => c.path);
      assert.ok(paths.includes('devtool.config.yaml') && paths.includes('pubspec.yaml'));
      // Navigator: the row pushes the detail page by its class.
      const list = r.changeSet.changes.find((c) => /products_page\.dart$/.test(c.path))!.after!;
      assert.match(list, /Navigator\.push\(context, MaterialPageRoute\(builder: \(_\) => ProductDetailPage\(productId: '\$\{items\[index\]\.id\}'\)\)\)/);
      assert.match(list, /Navigator\.pushNamed\(context, '\/products\/new'\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter --architecture getx: forms, Get.parameters and Routes links', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const r = await planFeatureAdd(dir, flutter, { name: 'products', spec: EXAMPLE, architecture: 'getx' });
      assert.equal(r.setup?.architecture, 'getx');
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail', 'edit']);
      const list = text(r, 'lib/app/modules/products/views/products_view.dart');
      assert.match(list, /Get\.toNamed\(Routes\.productDetail, parameters: \{'productId': '\$\{item\.id\}'\}\)\?\.then/);
      assert.match(list, /Get\.toNamed\(Routes\.newProduct\)\?\.then/);
      assert.match(text(r, 'lib/app/modules/product_detail/controllers/product_detail_controller.dart'), /final productId = Get\.parameters\['productId'\];\n {4}if \(productId != null\) loadProduct\(int\.parse\(productId\)\);/);
      const edit = text(r, 'lib/app/modules/edit_product/views/edit_product_view.dart');
      assert.match(edit, /class EditProductView extends StatefulWidget/);
      assert.match(edit, /Get\.find<ProductRepository>\(\)\.updateProduct\(int\.parse\(productId\), body\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('Next.js with no API layer gets the fetch helper, then the screens', async () => {
    const dir = copyFixture('nextjs-fresh');
    try {
      const r = await planFeatureAdd(dir, nextjs, { name: 'products', spec: EXAMPLE });
      assert.equal(r.setup?.architecture, 'fetch-helper');
      assert.equal(r.screens.length, 4);
    } finally {
      cleanup(dir);
    }
  });

  it('an unknown architecture is refused; a set-up project ignores --architecture with a warning', async () => {
    const fresh = copyFixture('flutter-fresh');
    const ready = copyFixture('rn-app');
    try {
      await assert.rejects(planFeatureAdd(fresh, flutter, { name: 'products', spec: EXAMPLE, architecture: 'mobx' }), /Unknown architecture "mobx"/);
      const r = await planFeatureAdd(ready, rn, { name: 'products', spec: EXAMPLE, architecture: 'axios' });
      assert.equal(r.setup, undefined);
      assert.ok(r.changeSet.warnings.some((w) => /already has an API layer, so --architecture axios was not used/.test(w)));
    } finally {
      cleanup(fresh);
      cleanup(ready);
    }
  });
});

describe('fixes from the first beta build check', () => {
  it('GetX auth add writes the login page into the view, not the binding; no unused Dio field', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const fr = await planFeatureAdd(dir, flutter, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), architecture: 'getx', tests: false });
      apply(dir, fr.changeSet);
      const r = await planAuthAdd(dir, flutter, {});
      const binding = r.changeSet.changes.find((c) => c.path.endsWith('login_binding.dart'))!.after!;
      assert.match(binding, /class LoginBinding extends Bindings/);
      const view = r.changeSet.changes.find((c) => c.path.endsWith('login_view.dart'))!.after!;
      assert.match(view, /class LoginView extends StatefulWidget/);
      assert.match(view, /Get\.offAllNamed\(AppPages\.initial\)/);
      const interceptor = r.changeSet.changes.find((c) => c.path.endsWith('auth_interceptor.dart'))!.after!;
      assert.doesNotMatch(interceptor, /_dio/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter form validators do not null-check a value already checked as required', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const r = await planFeatureAdd(dir, flutter, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), architecture: 'riverpod', tests: false });
      const form = r.changeSet.changes.find((c) => c.path.endsWith('new_product_page.dart'))!.after!;
      assert.match(form, /if \(double\.tryParse\(v\.trim\(\)\) == null\) return 'Enter a number';/);
    } finally {
      cleanup(dir);
    }
  });

  it('Next.js setup never writes .env.local, and the client falls back to the given URL', async () => {
    const dir = copyFixture('nextjs-fresh');
    try {
      const r = await planFeatureAdd(dir, nextjs, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml') });
      assert.ok(!r.changeSet.changes.some((c) => c.path === '.env.local'));
      assert.match(r.changeSet.changes.find((c) => c.path === 'lib/api/client.ts')!.after!, /process\.env\.NEXT_PUBLIC_API_URL \?\? ["']https:\/\/api\.example\.com\/v1["']/);
    } finally {
      cleanup(dir);
    }
  });

  it('React Native tests use Jest with typed globals from @jest/globals', async () => {
    const dir = copyFixture('rn-app');
    try {
      const r = await planFeatureAdd(dir, rn, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml') });
      const t = r.changeSet.changes.find((c) => c.path.endsWith('products.test.ts'))!.after!;
      assert.match(t, /import \{ afterEach, describe, expect, it, jest \} from '@jest\/globals';/);
    } finally {
      cleanup(dir);
    }
  });

  it('a query hook is matched to its own endpoint (the detail page does not get the list hook)', async () => {
    const dir = copyFixture('react-vite');
    try {
      const r = await planFeatureAdd(dir, ADAPTERS.react, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), architecture: 'axios-react-query' });
      const detail = r.changeSet.changes.find((c) => c.path.endsWith('ProductDetailPage.tsx'))!.after!;
      assert.doesNotMatch(detail, /useListProducts|useProducts\(/);
      assert.match(detail, /use\w*Product\w*\(Number\(productId\)\)/);
    } finally {
      cleanup(dir);
    }
  });
});
