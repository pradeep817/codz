import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyChangeSet, buildChangeSet, undoLast } from '../src/core/changeset.ts';
import { unifiedDiff } from '../src/core/diff.ts';
import type { Adapter } from '../src/core/types.ts';
import { parse, stringify } from '../src/core/yaml.ts';
import { cleanup, copyFixture } from './helpers.ts';

describe('yaml', () => {
  it('round-trips the config shape, quoting where YAML needs it', () => {
    const data = { framework: 'nextjs', conventions: { importAlias: '@/', apiFileSuffix: '', semicolons: 'true', path: 'a: b' }, list: ['x', 'y'] };
    const text = stringify(data, { 'conventions.importAlias': 'alias' });
    assert.match(text, /importAlias: '@\/'/);
    assert.match(text, /semicolons: 'true'/);
    assert.deepEqual(parse(text), data);
  });
  it('rejects tabs and bad indentation with a line number', () => {
    assert.throws(() => parse('a:\n\tb: 1'), /line 2/);
  });
});

describe('diff', () => {
  it('shows only changed hunks with context', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const b = a.replace('l5\n', 'L5\n');
    const d = unifiedDiff('f', a, b);
    assert.match(d, /@@ -3,7 \+3,7 @@/);
    assert.match(d, /-l5\n\+L5/);
    assert.ok(!d.includes('l20'));
  });
});

function git(dir: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

describe('change sets', () => {
  it('applies atomically, refuses a dirty tree and stale previews, and undoes', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'init');
      const edits = { files: new Map([['types/user.ts', 'export interface User { id: number }\n'], ['lib/new.ts', 'export const x = 1;\n']]), summary: ['test'], warnings: [], generated: [], rewrites: ['types/user.ts'] };

      // Dirty tree.
      writeFileSync(join(dir, 'app/page.tsx'), '// changed\n');
      const cs = buildChangeSet(dir, 'test', edits);
      assert.throws(() => applyChangeSet(dir, cs), /uncommitted/);
      git(dir, 'checkout', '-q', 'app/page.tsx');

      // Stale preview.
      const stale = buildChangeSet(dir, 'test', edits);
      writeFileSync(join(dir, 'types/user.ts'), 'export interface User { id: string }\n');
      assert.throws(() => applyChangeSet(dir, stale, { allowDirty: true }), /changed after the preview/);
      git(dir, 'checkout', '-q', 'types/user.ts');

      // Apply and undo.
      const ok = buildChangeSet(dir, 'test', edits);
      applyChangeSet(dir, ok);
      assert.equal(readFileSync(join(dir, 'types/user.ts'), 'utf8'), 'export interface User { id: number }\n');
      assert.ok(existsSync(join(dir, 'lib/new.ts')));
      undoLast(dir);
      assert.match(readFileSync(join(dir, 'types/user.ts'), 'utf8'), /email\?: string \| null/);
      assert.ok(!existsSync(join(dir, 'lib/new.ts')));
      assert.throws(() => undoLast(dir), /nothing to undo/);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses undo when a file changed after devtool wrote it', () => {
    const dir = copyFixture('nextjs-plain');
    try {
      const cs = buildChangeSet(dir, 'test', { files: new Map([['src/a.ts', 'a\n']]), summary: [], warnings: [], generated: [] });
      applyChangeSet(dir, cs);
      writeFileSync(join(dir, 'src/a.ts'), 'edited by hand\n');
      assert.throws(() => undoLast(dir), /changed after devtool wrote them/);
      undoLast(dir, { force: true });
      assert.ok(!existsSync(join(dir, 'src/a.ts')));
    } finally {
      cleanup(dir);
    }
  });

  it('reverts when the analyzer reports a new error in a changed file', () => {
    const dir = copyFixture('nextjs-plain');
    try {
      const fake = {
        verifyCommand: (_root: string, files: string[]) => ({ cmd: process.execPath, args: ['-e', `const fs=require('fs');for(const f of ${JSON.stringify(files)}){if(fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes('BROKEN'))console.log(f+'(1,1): error TS1: broken')}`] }),
      } as unknown as Adapter;
      const before = readFileSync(join(dir, 'src/models/index.ts'), 'utf8');
      const cs = buildChangeSet(dir, 'test', { files: new Map([['src/models/index.ts', 'BROKEN\n']]), summary: [], warnings: [], generated: [], rewrites: ['src/models/index.ts'] });
      assert.throws(() => applyChangeSet(dir, cs, { adapter: fake }), /new errors/);
      assert.equal(readFileSync(join(dir, 'src/models/index.ts'), 'utf8'), before);
    } finally {
      cleanup(dir);
    }
  });

  it('never writes outside the project root', () => {
    const dir = copyFixture('nextjs-plain');
    try {
      assert.throws(() => buildChangeSet(dir, 'test', { files: new Map([['../escape.ts', 'x']]), summary: [], warnings: [], generated: [] }), /outside the project root/);
    } finally {
      cleanup(dir);
    }
  });
});
