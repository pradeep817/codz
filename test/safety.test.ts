// Safety for beta testers: feature add followed by undo leaves every kind of
// project exactly as it was, and two runs cannot apply at the same time.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet, undoLast } from '../src/core/changeset.ts';
import { ToolError, type Adapter } from '../src/core/types.ts';
import { planAuthAdd } from '../src/skills/auth.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const EXAMPLE = join(REPO, 'examples', 'openapi.yaml');

/** Every file and folder of the project (devtool's own folder aside), with contents. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.devtool') continue;
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (statSync(abs).isDirectory()) {
        out.set(`${rel}/`, '');
        walk(abs);
      } else out.set(rel, readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

const cases: [string, keyof typeof ADAPTERS, Record<string, unknown>][] = [
  ['nextjs-fresh', 'nextjs', {}],
  ['nextjs-helper', 'nextjs', { skipConflicts: true }],
  ['react-vite', 'react', {}],
  ['react-router', 'react', {}],
  ['rn-app', 'react-native', {}],
  ['rn-expo-router', 'react-native', {}],
  ['flutter-fresh', 'flutter', { architecture: 'riverpod' }],
  ['flutter-fresh', 'flutter', { architecture: 'getx' }],
  ['flutter-bloc-retrofit', 'flutter', {}],
  ['android-app', 'android', {}],
  ['android-plain', 'android', {}],
  ['ios-swiftui', 'ios', { initial: true }],
];

describe('undo restores the project exactly', () => {
  for (const [fixture, id, extra] of cases) {
    it(`${fixture}${extra.architecture ? ` (${extra.architecture})` : ''}: feature add, then undo`, async () => {
      const dir = copyFixture(fixture);
      try {
        const before = snapshot(dir);
        const r = await planFeatureAdd(dir, ADAPTERS[id] as Adapter, { name: 'products', spec: EXAMPLE, ...extra });
        assert.ok(r.changeSet.changes.length > 0);
        applyChangeSet(dir, r.changeSet, { allowDirty: true, format: false, verify: false });
        assert.notDeepEqual(snapshot(dir), before);
        undoLast(dir);
        assert.deepEqual(snapshot(dir), before);
      } finally {
        cleanup(dir);
      }
    });
  }

  it('two changes undo in order (feature add, then auth add)', async () => {
    const dir = copyFixture('rn-app');
    try {
      const before = snapshot(dir);
      applyChangeSet(dir, (await planFeatureAdd(dir, ADAPTERS['react-native'], { name: 'products', spec: EXAMPLE })).changeSet, { allowDirty: true, format: false, verify: false });
      const middle = snapshot(dir);
      applyChangeSet(dir, (await planAuthAdd(dir, ADAPTERS['react-native'], {})).changeSet, { allowDirty: true, format: false, verify: false });
      undoLast(dir);
      assert.deepEqual(snapshot(dir), middle);
      undoLast(dir);
      assert.deepEqual(snapshot(dir), before);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses to undo over edits made after apply, unless forced', async () => {
    const dir = copyFixture('react-vite');
    try {
      const r = await planFeatureAdd(dir, ADAPTERS.react, { name: 'products', spec: EXAMPLE });
      applyChangeSet(dir, r.changeSet, { allowDirty: true, format: false, verify: false });
      writeFileSync(join(dir, 'src/pages/ProductsPage.tsx'), '// my edit\n');
      assert.throws(() => undoLast(dir), (e: unknown) => e instanceof ToolError && e.code === 'changed_since_apply');
      undoLast(dir, { force: true });
    } finally {
      cleanup(dir);
    }
  });
});

describe('one change at a time', () => {
  it('a lock held by a running process stops apply and undo', async () => {
    const dir = copyFixture('react-vite');
    try {
      const r = await planFeatureAdd(dir, ADAPTERS.react, { name: 'products', spec: EXAMPLE });
      mkdirSync(join(dir, '.devtool'), { recursive: true });
      // The parent process (the test runner) is alive.
      writeFileSync(join(dir, '.devtool', 'lock'), JSON.stringify({ pid: process.ppid, started: new Date().toISOString() }));
      assert.throws(() => applyChangeSet(dir, r.changeSet, { allowDirty: true, format: false, verify: false }), (e: unknown) => e instanceof ToolError && e.code === 'busy');
      assert.throws(() => undoLast(dir), (e: unknown) => e instanceof ToolError && e.code === 'busy');
    } finally {
      cleanup(dir);
    }
  });

  it('a lock left by a process that is gone is taken over, and released afterwards', async () => {
    const dir = copyFixture('react-vite');
    try {
      const r = await planFeatureAdd(dir, ADAPTERS.react, { name: 'products', spec: EXAMPLE });
      mkdirSync(join(dir, '.devtool'), { recursive: true });
      writeFileSync(join(dir, '.devtool', 'lock'), JSON.stringify({ pid: 2 ** 22 - 3, started: new Date().toISOString() }));
      applyChangeSet(dir, r.changeSet, { allowDirty: true, format: false, verify: false });
      assert.ok(!readdirSync(join(dir, '.devtool')).includes('lock'));
    } finally {
      cleanup(dir);
    }
  });
});

describe('devtool report', () => {
  it('counts commands, failures, applies and undos, with no paths or names in it', async () => {
    const { main } = await import('../src/cli.ts');
    const { readEvents } = await import('../src/core/events.ts');
    const dir = copyFixture('react-router');
    const write = process.stdout.write.bind(process.stdout);
    const ewrite = process.stderr.write.bind(process.stderr);
    let out = '';
    const cli = async (...a: string[]) => {
      process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
      process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
      try {
        return await main([...a, '--cwd', dir, '--no-color']);
      } finally {
        process.stdout.write = write;
        process.stderr.write = ewrite;
      }
    };
    try {
      await cli('init', '--yes');
      await cli('feature', 'add', 'products', '--spec', EXAMPLE, '--yes', '--allow-dirty', '--no-verify', '--no-format');
      await cli('screen', 'add', 'x', '--api', 'nope', '--yes');
      await cli('undo', '--yes');
      const events = readEvents(dir);
      assert.deepEqual(events.map((e) => `${e.cmd}:${e.ok ? 'ok' : e.code}`), ['init:ok', 'feature add:ok', 'screen add:no_endpoint', 'undo:ok']);
      assert.ok(events.every((e) => !JSON.stringify(e).includes('products') && !JSON.stringify(e).includes(dir)));
      out = '';
      await cli('report', '--json');
      const r = JSON.parse(out);
      assert.equal(r.framework, 'react');
      assert.equal(r.changes.applied, 1);
      assert.equal(r.changes.undone, 1);
      assert.equal(r.changes.undoRate, '100%');
      assert.deepEqual(r.errors, [{ code: 'no_endpoint', count: 1 }]);
      assert.ok(!out.includes(dir) && !out.includes('/products') && !out.includes('api.shop.dev'));
      assert.ok(!readEvents(dir).some((e) => e.cmd === 'report'), 'report itself is not recorded');
    } finally {
      cleanup(dir);
    }
  });

  it('records nothing in a folder devtool has not used, or with DEVTOOL_NO_EVENTS=1', async () => {
    const { recordEvent, readEvents } = await import('../src/core/events.ts');
    const dir = copyFixture('react-vite');
    try {
      recordEvent(dir, { t: new Date().toISOString(), cmd: 'explain', ok: true, ms: 1, v: 'x' });
      assert.ok(!readdirSync(dir).includes('.devtool'));
      mkdirSync(join(dir, '.devtool'));
      process.env.DEVTOOL_NO_EVENTS = '1';
      recordEvent(dir, { t: new Date().toISOString(), cmd: 'explain', ok: true, ms: 1, v: 'x' });
      delete process.env.DEVTOOL_NO_EVENTS;
      assert.equal(readEvents(dir).length, 0);
    } finally {
      delete process.env.DEVTOOL_NO_EVENTS;
      cleanup(dir);
    }
  });
});
