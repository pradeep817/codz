// CLI integration tests: run bin/codz.js as a real process, the way users
// and CI do, and check exit codes, stdout/stderr and the files on disk.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanup, copyFixture, INPUTS, REPO } from './helpers.ts';

const BIN = join(REPO, 'bin', 'codz.js');

function run(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? REPO,
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...opts.env },
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const json = (s: string) => JSON.parse(s);

function gitRepo(dir: string): boolean {
  const g = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  if (g('--version').status !== 0) return false;
  writeFileSync(join(dir, '.gitignore'), '.codz/\n');
  g('init', '-q');
  g('add', '-A');
  return g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init').status === 0;
}

describe('CLI: basics and exit codes', () => {
  it('--help and --version exit 0; no command exits 1; a bad flag exits 2', () => {
    assert.equal(run(['--help']).code, 0);
    assert.match(run(['--version']).out, /^\d+\.\d+\.\d+/);
    assert.equal(run([]).code, 1);
    const bad = run(['api', 'add', '--url']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--url needs a value/);
  });

  it('errors are one JSON object on stdout with --json', () => {
    const r = run(['nonsense', '--json']);
    assert.equal(r.code, 1);
    assert.equal(json(r.out).ok, false);
    assert.equal(json(r.out).error.code, 'bad_args');
  });
});

describe('CLI: change pipeline', () => {
  it('api add --dry-run writes nothing; --plan + apply writes exactly the plan; undo restores', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const dry = run(['api', 'add', '--url', 'https://api.example.com/orders', '--sample', join(INPUTS, 'products.json'), '--dry-run'], { cwd: dir });
      assert.equal(dry.code, 0, dry.err);
      assert.match(dry.out, /\d+ files?: .*created/);
      assert.equal(existsSync(join(dir, 'lib/api/orders.ts')), false);
      assert.equal(existsSync(join(dir, '.codz')), false);

      const plan = run(['api', 'add', '--url', 'https://api.example.com/orders', '--sample', join(INPUTS, 'products.json'), '--plan', '--json'], { cwd: dir });
      const id = json(plan.out).planId;
      assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
      assert.equal(json(run(['plans', 'list', '--json'], { cwd: dir }).out).plans[0].status, 'ready');
      const applied = run(['apply', id, '--allow-dirty', '--no-verify', '--json'], { cwd: dir });
      assert.equal(json(applied.out).applied, true);
      assert.ok(existsSync(join(dir, 'lib/api/orders.ts')));
      assert.equal(run(['undo'], { cwd: dir }).code, 0);
      assert.equal(existsSync(join(dir, 'lib/api/orders.ts')), false);
    } finally {
      cleanup(dir);
    }
  });

  it('pasted input on stdin works without a terminal', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = run(['api', 'add', '--dry-run', '--json'], { cwd: dir, input: readFileSync(join(INPUTS, 'order-curl.txt'), 'utf8') });
      assert.equal(r.code, 0, r.err);
      assert.ok(json(r.out).changeSet.files.some((f: { path: string }) => f.path === 'lib/api/users.ts'));
    } finally {
      cleanup(dir);
    }
  });

  it('refuses a dirty git tree; --commit commits exactly the change', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      if (!gitRepo(dir)) return;
      writeFileSync(join(dir, 'scratch.txt'), 'x');
      const refused = run(['api', 'add', '--url', 'https://api.example.com/orders', '--yes', '--json'], { cwd: dir });
      assert.equal(json(refused.out).error.code, 'dirty_git');
      spawnSync('git', ['add', 'scratch.txt'], { cwd: dir });
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'scratch'], { cwd: dir });
      const r = run(['api', 'add', '--url', 'https://api.example.com/orders', '--yes', '--no-verify', '--commit', '--commit-message', 'Add orders API', '--json'], { cwd: dir });
      assert.equal(r.code, 0, r.out + r.err);
      assert.match(json(r.out).commit, /^[0-9a-f]{7,}$/);
      const log = spawnSync('git', ['log', '-1', '--pretty=%s', '--name-only'], { cwd: dir, encoding: 'utf8' }).stdout;
      assert.match(log, /^Add orders API\n/);
      assert.match(log, /lib\/api\/orders\.ts/);
      assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
    } finally {
      cleanup(dir);
    }
  });
});

describe('CLI: read-only commands', () => {
  it('doctor exits 1 on errors, check fails on warnings, doctor --setup reports checks', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'messages/en.json'), JSON.stringify({ home: { title: 'Welcome' }, profile: { title: 'Profile' }, extra: 'x' }));
      assert.equal(run(['doctor'], { cwd: dir }).code, 1);
      const check = run(['check', '--json'], { cwd: dir });
      assert.equal(check.code, 1);
      assert.equal(json(check.out).passed, false);
      const setup = run(['doctor', '--setup', '--json'], { cwd: dir });
      assert.equal(json(setup.out).checks.length, 13);
      assert.equal(existsSync(join(dir, '.codz')), false, 'read-only commands leave no files');
    } finally {
      cleanup(dir);
    }
  });

  it('api list / api show / config / import --list answer in JSON', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      assert.deepEqual(json(run(['api', 'list', '--json'], { cwd: dir }).out).endpoints.map((e: { name: string }) => e.name), ['getUser', 'updateUser']);
      assert.equal(json(run(['api', 'show', 'getUser', '--json'], { cwd: dir }).out).endpoint.method, 'GET');
      assert.ok(json(run(['config', '--json'], { cwd: dir }).out).rows.some((r: { key: string }) => r.key === 'httpHelper'));
      const l = json(run(['api', 'import', join(INPUTS, 'shop.har'), '--list', '--base-url', 'https://api.shop.dev', '--json'], { cwd: dir }).out);
      assert.equal(l.operations.length, 4);
    } finally {
      cleanup(dir);
    }
  });

  it('completion scripts print, and __complete answers even for half-typed flags', () => {
    for (const shell of ['bash', 'zsh', 'fish']) assert.match(run(['completion', shell]).out, /__complete/);
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), 'framework: nextjs\nconventions:\n  quote: single\n');
      assert.deepEqual(run(['__complete', 'api', 'show', ''], { cwd: dir }).out.trim().split('\n'), ['getUser', 'updateUser']);
      assert.match(run(['__complete', 'mock', 'add', '--ke'], { cwd: dir }).out, /--keep-values/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('CLI: phase 2 commands', () => {
  it('doctor --fix --yes repairs, history show describes it, undo reverts it', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'types/team.ts'), 'export interface Team {\n  id: number;\n}\n');
      const fix = run(['doctor', '--fix', '--yes', '--no-verify', '--json'], { cwd: dir });
      assert.equal(json(fix.out).applied, true, fix.out + fix.err);
      assert.equal(existsSync(join(dir, 'types/team.ts')), false);
      const id = json(fix.out).id;
      const show = json(run(['history', 'show', id, '--json'], { cwd: dir }).out);
      assert.equal(show.files.find((f: { path: string }) => f.path === 'types/team.ts').action, 'deleted');
      assert.equal(run(['undo', '--to', id], { cwd: dir }).code, 0);
      assert.ok(existsSync(join(dir, 'types/team.ts')));
    } finally {
      cleanup(dir);
    }
  });

  it('screen add --dry-run shows the page, loading and error files', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = run(['screen', 'add', 'user-profile', '--api', 'getUser', '--path', '/users/:id', '--dry-run', '--json'], { cwd: dir });
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(json(r.out).changeSet.files.map((f: { path: string }) => f.path).sort(), ['app/users/[id]/error.tsx', 'app/users/[id]/loading.tsx', 'app/users/[id]/page.test.tsx', 'app/users/[id]/page.tsx', 'package.json', 'vitest.config.mts']);
      const plain = run(['screen', 'add', 'user-profile', '--api', 'getUser', '--path', '/users/:id', '--no-tests', '--dry-run', '--json'], { cwd: dir });
      assert.deepEqual(json(plain.out).changeSet.files.map((f: { path: string }) => f.path).sort(), ['app/users/[id]/error.tsx', 'app/users/[id]/loading.tsx', 'app/users/[id]/page.tsx'], '--no-tests leaves the test out');
    } finally {
      cleanup(dir);
    }
  });
});
