// Stage B: exact edits through the project's own TypeScript compiler.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiRename, planApiRemove } from '../src/skills/apiEdit.ts';
import { cleanup, copyFixture, INPUTS } from './helpers.ts';

const { nextjs } = ADAPTERS;
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? null;

/** A TypeScript install to link into a fixture, or null when none is on this machine. */
function findTypeScript(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(realpathSync(execFileSync('which', ['tsc'], { encoding: 'utf8' }).trim())), '..'));
  } catch {
    // No tsc on PATH.
  }
  candidates.push(join(import.meta.dirname, '..', 'node_modules', 'typescript'));
  return candidates.find((c) => existsSync(join(c, 'lib', 'typescript.js'))) ?? null;
}
const TS_DIR = findTypeScript();

function withTypeScript(dir: string) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(TS_DIR!, join(dir, 'node_modules', 'typescript'), process.platform === 'win32' ? 'junction' : 'dir');
}

const TRICKY = `import { getUser } from '@/lib/api/users';

const handlers = { getUser: () => 1 };

export function shadowParam(getUser: () => number) {
  return getUser();
}

export function shadowLocal() {
  const getUser = () => 2;
  return getUser();
}

export function nested() {
  if (handlers) {
    const getUser = 3;
    void getUser;
  }
  return getUser(7);
}

export const tearOff = getUser;
export const label = \`calls getUser\`; // getUser in a comment
`;

const UNRELATED = `// Its own getUser, not the endpoint.
function getUser() {
  return 0;
}
export const x = getUser();
`;

describe('stage B: TypeScript syntax trees', { skip: TS_DIR ? false : 'no TypeScript on this machine' }, () => {
  it('rename changes the endpoint and its real uses, never shadowing locals, object keys or other bindings', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      withTypeScript(dir);
      writeFileSync(join(dir, 'lib/tricky.ts'), TRICKY);
      writeFileSync(join(dir, 'lib/unrelated.ts'), UNRELATED);
      const cs = await planApiRename(dir, nextjs, 'getUser', 'fetchUser');
      const t = after(cs, 'lib/tricky.ts')!;
      assert.match(t, /^import \{ fetchUser \} from/);
      assert.match(t, /const handlers = \{ getUser: \(\) => 1 \}/, 'object key untouched');
      assert.match(t, /shadowParam\(getUser: \(\) => number\) \{\n  return getUser\(\);/, 'parameter shadow untouched');
      assert.match(t, /const getUser = \(\) => 2;\n  return getUser\(\);/, 'local shadow untouched');
      assert.match(t, /void getUser;\n  \}\n  return fetchUser\(7\);/, 'inner block shadow does not hide the outer call');
      assert.match(t, /export const tearOff = fetchUser;/);
      assert.match(t, /calls getUser`; \/\/ getUser in a comment/, 'strings and comments untouched');
      assert.equal(after(cs, 'lib/unrelated.ts'), null, 'a file with its own getUser is not touched');
      assert.match(after(cs, 'app/profile/page.tsx')!, /await fetchUser\(1\)/);
      assert.match(after(cs, 'lib/api/users.ts')!, /export function fetchUser\(id: number\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('remove lists only real callers', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      withTypeScript(dir);
      writeFileSync(join(dir, 'lib/unrelated.ts'), UNRELATED);
      const cs = await planApiRemove(dir, nextjs, 'getUser');
      const w = cs.warnings.join('\n');
      assert.match(w, /app\/profile\/page\.tsx:5/);
      assert.doesNotMatch(w, /unrelated\.ts/);
    } finally {
      cleanup(dir);
    }
  });

  it('CODZ_NO_AST=1 falls back to the text scanner', async () => {
    const dir = copyFixture('nextjs-helper');
    process.env.CODZ_NO_AST = '1';
    try {
      withTypeScript(dir);
      const cs = await planApiRename(dir, nextjs, 'getUser', 'fetchUser');
      assert.match(after(cs, 'app/profile/page.tsx')!, /await fetchUser\(1\)/);
    } finally {
      delete process.env.CODZ_NO_AST;
      cleanup(dir);
    }
  });
});

describe('stage B: problems found by the corpus run', () => {
  it('a comment line in pubspec.yaml does not end the dependencies list', async () => {
    const { pubspecDeps } = await import('../src/adapters/flutter.ts');
    const deps = pubspecDeps('dependencies:\n  get_it: ^7.2.0\n#    git:\n#      url: x\n  http: ^1.1.0\n\n  dio: ^5.0.0\nflutter:\n  uses-material-design: true\n');
    assert.ok(deps.has('http') && deps.has('dio') && !deps.has('uses-material-design'));
  });

  it('get_it through GetIt.I: registers in the same style, warns when no Dio is registered', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      const di = readFileSync(join(dir, 'lib/di.dart'), 'utf8')
        .replace('final getIt = GetIt.instance;\n', '')
        .replace(/getIt\.registerLazySingleton<Dio>[^\n]*\n/, '')
        .replace(/getIt\.registerLazySingleton<JobService>\(\(\) => JobService\(getIt\(\)\)\);/, 'GetIt.I.registerLazySingleton<JobService>(() => JobService(GetIt.I()));');
      writeFileSync(join(dir, 'lib/di.dart'), di);
      const { changeSet } = await planApiAdd(dir, ADAPTERS.flutter, { url: 'https://ops.example.com/api/v2/crews', samples: [join(INPUTS, 'products.json')] });
      const out = after(changeSet, 'lib/di.dart')!;
      assert.match(out, /GetIt\.I\.registerLazySingleton<CrewRepository>\(\(\) => CrewRepository\(GetIt\.I\(\)\)\);|GetIt\.I\.registerLazySingleton<CrewService>\(\(\) => CrewService\(GetIt\.I\(\)\)\);/);
      assert.match(changeSet.warnings.join('\n'), /No Dio is registered/);
    } finally {
      cleanup(dir);
    }
  });

  it('no registration point: no stray import, a warning with the line to add', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      writeFileSync(join(dir, 'lib/di.dart'), "import 'package:get_it/get_it.dart';\n\nvoid setupDependencies() {\n  GetIt.I.registerFactory<Object>(\n    () => Object(),\n  );\n}\n");
      const { changeSet } = await planApiAdd(dir, ADAPTERS.flutter, { url: 'https://ops.example.com/api/v2/crews', samples: [join(INPUTS, 'products.json')] });
      assert.equal(after(changeSet, 'lib/di.dart'), null);
      assert.match(changeSet.warnings.join('\n'), /register \w+ there by hand: GetIt\.I\.registerLazySingleton</);
    } finally {
      cleanup(dir);
    }
  });

  it('a missing dio dependency is reported', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      writeFileSync(join(dir, 'pubspec.yaml'), readFileSync(join(dir, 'pubspec.yaml'), 'utf8').replace(/^\s+dio:.*\n/m, ''));
      const { changeSet } = await planApiAdd(dir, ADAPTERS.flutter, { url: 'https://ops.example.com/api/v2/crews', samples: [join(INPUTS, 'products.json')] });
      assert.match(changeSet.warnings.join('\n'), /dio is not in pubspec\.yaml/);
    } finally {
      cleanup(dir);
    }
  });

  it('feature-first projects: new models go to lib/models, not one feature folder', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      const model = (n: string) => `class ${n} {\n  ${n}();\n  factory ${n}.fromJson(Map<String, dynamic> json) => ${n}();\n}\n`;
      for (const [f, n] of [['account/models/a.dart', 'A'], ['shop/models/b.dart', 'B'], ['order/models/c.dart', 'C'], ['goods/models/d.dart', 'D']]) {
        mkdirSync(join(dir, 'lib', dirname(f)), { recursive: true });
        writeFileSync(join(dir, 'lib', f), model(n));
      }
      // Five model folders with one model each: none of them is the models folder.
      rmSync(join(dir, 'lib/models'), { recursive: true });
      mkdirSync(join(dir, 'lib/catalog/models'), { recursive: true });
      writeFileSync(join(dir, 'lib/catalog/models/job.dart'), model('Job'));
      const { changeSet } = await planApiAdd(dir, ADAPTERS.flutter, { url: 'https://ops.example.com/api/v2/crews', samples: [join(INPUTS, 'products.json')] });
      const created = changeSet.changes.filter((c) => c.before === null || c.before === undefined).map((c) => c.path);
      assert.ok(created.some((p) => p.startsWith('lib/models/')), created.join(', '));
      assert.ok(!created.some((p) => /^lib\/(account|shop|order|goods)\//.test(p)), created.join(', '));
    } finally {
      cleanup(dir);
    }
  });
});
