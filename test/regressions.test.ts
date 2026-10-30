// Regression tests for bugs found in review. Each test names the bug it guards.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { maskCode } from '../src/adapters/source.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { walk } from '../src/core/fsutil.ts';
import { dirtyFiles } from '../src/core/git.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { main } from '../src/cli.ts';
import { parseCurl } from '../src/input/curl.ts';
import { functionName } from '../src/input/naming.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiRemove, planApiRename } from '../src/skills/apiEdit.ts';
import { planApiImport } from '../src/skills/apiImport.ts';
import { planMockAdd, scrubSample } from '../src/skills/mock.ts';
import { dartArgb, parseToken, planThemeSet } from '../src/skills/theme.ts';
import { cleanup, copyFixture, GOLDEN, INPUTS } from './helpers.ts';

const { flutter, nextjs } = ADAPTERS;
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? '';
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });

/** Runs the CLI in-process with output captured. */
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
  try {
    return { code: await main(args), out };
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
}

describe('scanning ignores OS junk files', () => {
  it('.DS_Store, Thumbs.db and ._ files are skipped; .env files are not', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      for (const f of ['.DS_Store', 'app/.DS_Store', 'Thumbs.db', 'lib/._client.ts', 'desktop.ini']) writeFileSync(join(dir, f), 'x');
      writeFileSync(join(dir, '.env.local'), 'NEXT_PUBLIC_API_URL=https://api.example.com\n');
      const files = walk(dir);
      assert.ok(!files.some((f) => /(\.DS_Store|Thumbs\.db|desktop\.ini|\/\._)/.test(f)), files.join(', '));
      assert.ok(files.includes('.env.local') && files.includes('.env.example'));
    } finally {
      cleanup(dir);
    }
  });

  it('a project with .DS_Store files scans exactly like the golden map', async () => {
    for (const name of ['nextjs-helper', 'flutter-riverpod']) {
      const dir = copyFixture(name);
      try {
        writeFileSync(join(dir, '.DS_Store'), 'x');
        mkdirSync(join(dir, 'lib'), { recursive: true });
        writeFileSync(join(dir, 'lib/.DS_Store'), 'x');
        const { map } = await loadMap(dir, ADAPTERS[name.startsWith('flutter') ? 'flutter' : 'nextjs'], {});
        const expected = JSON.parse(readFileSync(join(GOLDEN, 'maps', `${name}.json`), 'utf8'));
        assert.deepEqual(map.stats, expected.stats);
        assert.deepEqual(JSON.parse(JSON.stringify(map)), expected);
      } finally {
        cleanup(dir);
      }
    }
  });
});

describe('read-only runs leave no files behind', () => {
  it('--dry-run and doctor do not write the scan cache', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await cli(['--root', dir, 'api', 'add', '--url', 'https://api.example.com/things', '--dry-run', '--no-color']);
      assert.equal(r.code, 0, r.out);
      await cli(['--root', dir, 'doctor', '--no-color']);
      assert.equal(existsSync(join(dir, '.codz')), false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('api import: names and path parameters that must compile', () => {
  const spec = `openapi: 3.0.0
info: { title: T, version: '1' }
servers: [{ url: https://api.example.com }]
paths:
  /accounts/{account-id}:
    get:
      operationId: getAccount
      parameters: [{ name: account-id, in: path, required: true, schema: { type: integer } }]
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Account' } } } } }
    delete:
      operationId: delete
      parameters: [{ name: account-id, in: path, required: true, schema: { type: integer } }]
      responses: { '204': { description: gone } }
  /2fa/verify:
    post:
      operationId: 2fa.verify
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/2FAResult' } } } } }
components:
  schemas:
    Account: { type: object, properties: { id: { type: integer }, name: { type: string } } }
    2FAResult: { type: object, properties: { ok: { type: boolean } } }
`;

  it('functionName avoids reserved words and leading digits', () => {
    assert.equal(functionName('delete', 'DELETE', 'deleteAccount'), 'deleteAccount');
    assert.equal(functionName('class', 'GET'), 'classRequest');
    assert.equal(functionName('2fa.verify', 'POST'), 'post2faVerify');
    assert.equal(functionName('getUser', 'GET'), 'getUser');
  });

  for (const [fixture, adapter] of [['nextjs-helper', nextjs], ['flutter-riverpod', flutter]] as const) {
    it(`${fixture}: no reserved or digit-first identifiers; {account-id} is a parameter`, async () => {
      const dir = copyFixture(fixture);
      try {
        writeFileSync(join(dir, 'spec.yaml'), spec);
        const r = await planApiImport(dir, adapter, { file: join(dir, 'spec.yaml') });
        assert.deepEqual(r.skipped, []);
        assert.deepEqual(r.added.sort(), ['deleteAccount', 'getAccount', 'post2faVerify']);
        const code = r.changeSet.changes.map((c) => c.after).join('\n');
        assert.doesNotMatch(code, /\b(function|class|Future<[^>]*>)\s+(delete|\d\w*)\b/);
        assert.doesNotMatch(code, /\{account-id\}|AccountId\b/);
        assert.match(code, adapter === nextjs ? /getAccount\(accountId: number\)/ : /getAccount\(int accountId\)/);
      } finally {
        cleanup(dir);
      }
    });
  }
});

describe('api remove / rename', () => {
  function setupNext(): string {
    const dir = copyFixture('nextjs-helper');
    writeFileSync(
      join(dir, 'lib/api/users.ts'),
      [
        "import { apiFetch } from './client';",
        "import { type User } from '@/types';",
        "import { formatDate } from '@/lib/format';",
        '',
        '/** GET /users/{id} */',
        'export function getUser(id: number): Promise<User> {',
        '  return apiFetch<User>(`/users/${id}`);',
        '}',
        '',
        '/** PATCH /users/{id} */',
        'export function updateUser(id: number, body: Partial<User>): Promise<User> {',
        "  return apiFetch<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });",
        '}',
        '',
        'export async function refreshUser(id: number) {',
        '  // getUser is cached elsewhere',
        '  return getUser(id);',
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'lib/api/index.ts'), "export * from './client';\nexport { getUser, updateUser } from './users';\n");
    mkdirSync(join(dir, 'lib/hooks'), { recursive: true });
    writeFileSync(
      join(dir, 'lib/hooks/use-user.ts'),
      "import { getUser } from '@/lib/api';\nconst cache = { getUser: (id: number) => null };\nexport function useUser(id: number) {\n  const key = ['getUser', id];\n  cache.getUser(id);\n  return { key, run: () => getUser(id) };\n}\n",
    );
    return dir;
  }

  it('remove keeps imports other functions still use, and only that function goes', async () => {
    const dir = setupNext();
    try {
      const cs = await planApiRemove(dir, nextjs, 'updateUser');
      const users = after(cs, 'lib/api/users.ts');
      assert.match(users, /import \{ type User \} from '@\/types';/);
      assert.match(users, /export function getUser/);
      assert.match(users, /\/\*\* GET \/users\/\{id\} \*\//);
      assert.doesNotMatch(users, /updateUser/);
      // An import that was already unused is not this command's business.
      assert.match(users, /formatDate/);
      // The named re-export is reported.
      assert.match(cs.warnings.join('\n'), /lib\/api\/index\.ts:2/);
    } finally {
      cleanup(dir);
    }
  });

  it('remove reports calls in the same file', async () => {
    const dir = setupNext();
    try {
      const cs = await planApiRemove(dir, nextjs, 'getUser');
      assert.match(cs.warnings.join('\n'), /lib\/api\/users\.ts:\d+ {2}return getUser\(id\);/);
    } finally {
      cleanup(dir);
    }
  });

  it('rename changes same-file calls and re-exports, not strings or other objects', async () => {
    const dir = setupNext();
    try {
      const cs = await planApiRename(dir, nextjs, 'getUser', 'fetchUser');
      const users = after(cs, 'lib/api/users.ts');
      assert.match(users, /export function fetchUser\(/);
      assert.match(users, /return fetchUser\(id\);/);
      assert.match(users, /\/\/ getUser is cached elsewhere/);
      assert.match(after(cs, 'lib/api/index.ts'), /export \{ fetchUser, updateUser \}/);
      const hook = after(cs, 'lib/hooks/use-user.ts');
      assert.match(hook, /import \{ fetchUser \}/);
      assert.match(hook, /\['getUser', id\]/);
      assert.match(hook, /cache\.getUser\(id\)/);
      assert.match(hook, /const cache = \{ getUser:/);
      assert.match(hook, /run: \(\) => fetchUser\(id\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('Dart rename leaves .getUser on unrelated classes alone', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      writeFileSync(join(dir, 'lib/cache.dart'), "class Cache {\n  Object? getUser(int id) => null;\n}\nvoid f(Cache c) {\n  c.getUser(1);\n}\n");
      const cs = await planApiRename(dir, flutter, 'getUser', 'fetchUser');
      assert.equal(cs.changes.some((c) => c.path === 'lib/cache.dart'), false);
      assert.match(after(cs, 'lib/features/profile/profile_page.dart'), /userRepositoryProvider\)\.fetchUser\(id\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('maskCode hides strings and comments but keeps template expressions', () => {
    const m = maskCode("const a = 'getUser'; // getUser\nconst b = `x${getUser(1)}`;", 'ts');
    assert.equal((m.match(/getUser/g) ?? []).length, 1);
  });
});

describe('theme set', () => {
  it('8-digit colors become AARRGGBB in Flutter and stay #rrggbbaa in CSS', async () => {
    assert.equal(dartArgb('11223380'), '80112233');
    assert.equal(dartArgb('112233'), 'FF112233');
    assert.equal(parseToken('overlay', '#1238').value, '11223388');
    const dir = copyFixture('flutter-fresh');
    try {
      const cs = await planThemeSet(dir, flutter, [{ name: 'overlay', value: '#11223380' }]);
      assert.match(after(cs, 'lib/core/theme/app_colors.dart'), /Color\(0x80112233\)/);
    } finally {
      cleanup(dir);
    }
    const web = copyFixture('nextjs-fresh');
    try {
      const cs = await planThemeSet(web, nextjs, [{ name: 'overlay', value: '#11223380' }]);
      assert.match(after(cs, 'app/globals.css'), /--color-overlay: #11223380;/);
    } finally {
      cleanup(web);
    }
  });
});

describe('mock add', () => {
  it('--sample values that look like secrets or personal data are replaced', () => {
    const replaced = new Set<string>();
    const out = scrubSample(
      { id: 7, access_token: 'eyJhbGciOi.eyJzdWIiOi.c2ln', user: { email: 'real@person.com', phone: '+91 98765 43210', role: 'admin' }, note: 'a'.repeat(48) },
      { endpoints: [], models: [] } as never,
      replaced,
    ) as Record<string, any>;
    assert.equal(out.id, 7);
    assert.equal(out.user.role, 'admin');
    assert.notEqual(out.access_token, 'eyJhbGciOi.eyJzdWIiOi.c2ln');
    assert.notEqual(out.user.email, 'real@person.com');
    assert.notEqual(out.user.phone, '+91 98765 43210');
    assert.notEqual(out.note, 'a'.repeat(48));
    assert.deepEqual([...replaced].sort(), ['access_token', 'email', 'note', 'phone']);
  });

  it('Next.js findMock treats "." in a path literally', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      apply(dir, (await planApiAdd(dir, nextjs, { url: 'https://api.example.com/files/report.json', samples: [join(INPUTS, 'user.json')] })).changeSet);
      const cs = await planMockAdd(dir, nextjs, { endpoints: [], all: true });
      const mocksTs = after(cs, 'lib/api/mocks.ts');
      writeFileSync(join(dir, 'mocks-check.ts'), mocksTs);
      const mod = await import(pathToFileURL(join(dir, 'mocks-check.ts')).href);
      assert.notEqual(mod.findMock('GET', '/files/report.json'), undefined);
      assert.equal(mod.findMock('GET', '/files/reportxjson'), undefined);
      assert.notEqual(mod.findMock('GET', '/users/42'), undefined);
      assert.equal(mod.findMock('GET', '/users/42/extra'), undefined);
    } finally {
      cleanup(dir);
    }
  });
});

describe('cURL parsing', () => {
  it('-F is a multipart upload, not the URL', () => {
    const r = parseCurl("curl -F 'file=@x.png' -F 'title=Hi' https://api.example.com/uploads");
    assert.equal(r.url.pathname, '/uploads');
    assert.equal(r.method, 'POST');
    assert.deepEqual(r.form, [{ name: 'file', file: true }, { name: 'title', file: false }]);
    assert.match(r.notes.join(' '), /multipart/);
  });

  it('short flags with attached values: -XPOST, -HAccept:x, -sSX PUT', () => {
    assert.equal(parseCurl('curl -XPOST https://api.example.com/a').method, 'POST');
    assert.equal(parseCurl('curl -sSX PUT https://api.example.com/a').method, 'PUT');
    assert.deepEqual(parseCurl("curl -H'Accept: application/json' https://api.example.com/a").headers, [{ name: 'Accept', value: 'application/json' }]);
    assert.equal(parseCurl('curl -sL https://api.example.com/a').url.pathname, '/a');
  });

  it('-G -d with a literal % does not crash', () => {
    const r = parseCurl("curl -G -d 'q=100%' -d 'tag=a%20b' https://api.example.com/search");
    assert.equal(r.url.searchParams.get('q'), '100%');
    assert.equal(r.url.searchParams.get('tag'), 'a b');
  });

  it('--method must be an HTTP method; --json errors stay JSON', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await cli(['--root', dir, 'api', 'add', '--url', 'https://api.example.com/x', '--method', 'fetch', '--dry-run', '--json']);
      assert.equal(r.code, 1);
      assert.equal(JSON.parse(r.out).error.code, 'bad_method');
    } finally {
      cleanup(dir);
    }
  });
});

describe('git', () => {
  it('dirtyFiles works when the project is a subfolder of the repository', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' });
      if (git('--version').status !== 0) return;
      mkdirSync(join(dir, 'apps/web'), { recursive: true });
      writeFileSync(join(dir, 'apps/web/package.json'), '{}');
      git('init', '-q');
      git('add', '-A');
      git('commit', '-qm', 'init');
      mkdirSync(join(dir, 'apps/web/.codz'), { recursive: true });
      writeFileSync(join(dir, 'apps/web/.codz/x'), 'x');
      writeFileSync(join(dir, 'apps/web/new file.ts'), 'x');
      writeFileSync(join(dir, 'outside.ts'), 'x');
      assert.deepEqual(dirtyFiles(join(dir, 'apps/web')), ['new file.ts']);
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage A: keeping hand-written work', () => {
  it('api update keeps hand-written Dart members and warns about removed fields they use', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      const f = join(dir, 'lib/data/models/user_model.dart');
      const t = readFileSync(f, 'utf8').trimEnd().replace(/\}$/, '');
      writeFileSync(f, `${t}\n  /// Display label.\n  String get label => email == null ? name : '$name <$email>';\n\n  @override\n  String toString() => 'UserModel($id)';\n}\n`);
      writeFileSync(join(dir, 'new.json'), JSON.stringify({ id: 1, name: 'A', phone: 'x' }));
      const { planApiUpdate } = await import('../src/skills/apiEdit.ts');
      const r = await planApiUpdate(dir, flutter, 'getUser', [join(dir, 'new.json')]);
      const model = after(r.changeSet, 'lib/data/models/user_model.dart');
      assert.match(model, /\/\/\/ Display label\.\n {2}String get label =>/);
      assert.match(model, /String toString\(\) => 'UserModel\(\$id\)';/);
      assert.match(model, /final String phone;/);
      assert.match(r.changeSet.summary.join('\n'), /Kept your members of UserModel: label, toString/);
      assert.match(r.changeSet.warnings.join('\n'), /UserModel\.label still uses removed field email/);
    } finally {
      cleanup(dir);
    }
  });

  it('api update keeps comments above TypeScript interface fields', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'types/user.ts'), 'export interface User {\n  /** Server id. */\n  id: number;\n  name: string;\n  email?: string | null;\n}\n');
      writeFileSync(join(dir, 'new.json'), JSON.stringify({ id: 1, name: 'A', phone: 'x' }));
      const { planApiUpdate } = await import('../src/skills/apiEdit.ts');
      const r = await planApiUpdate(dir, nextjs, 'getUser', [join(dir, 'new.json')]);
      assert.match(after(r.changeSet, 'types/user.ts'), /\/\*\* Server id\. \*\/\n {2}id: number;/);
    } finally {
      cleanup(dir);
    }
  });

  it('mock add keeps mocks edited by hand unless --force', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      apply(dir, await planMockAdd(dir, nextjs, { endpoints: [], all: true }));
      const f = join(dir, 'lib/api/mocks.ts');
      writeFileSync(f, readFileSync(f, 'utf8').replace('"Sample name 1"', '"Edited"'));
      const again = await planMockAdd(dir, nextjs, { endpoints: [], all: true });
      assert.ok(!again.changes.some((c) => c.path === 'lib/api/mocks.ts'), 'the edited mock is kept');
      assert.match(again.warnings.join('\n'), /Kept mocks you edited by hand: getUser/);
      const forced = await planMockAdd(dir, nextjs, { endpoints: [], all: true, force: true });
      assert.doesNotMatch(after(forced, 'lib/api/mocks.ts'), /"Edited"/);
    } finally {
      cleanup(dir);
    }
  });

  it('doctor pairs useTranslations namespaces with t() calls per file', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'components/home.tsx'), "import { useTranslations } from 'next-intl';\nexport function Home() {\n  const t = useTranslations('home');\n  return <h1>{t('title')}</h1>;\n}\n");
      writeFileSync(join(dir, 'components/other.tsx'), "import { useTranslations } from 'next-intl';\nexport function Other() {\n  const t = useTranslations('other');\n  return <p>{t('title')}</p>;\n}\n");
      const { runDoctor } = await import('../src/skills/doctor.ts');
      const r = await runDoctor(dir, nextjs, { only: ['locales'] });
      const unused = r.findings.find((f) => /look(s)? unused/.test(f.message))?.message ?? '';
      assert.doesNotMatch(unused, /home\.title/);
      assert.match(unused, /profile\.title/, 'other.title does not make profile.title used');
    } finally {
      cleanup(dir);
    }
  });
});
