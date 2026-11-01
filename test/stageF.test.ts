// Stage F: reach. The npm build and the VS Code extension.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { COMMAND_LIST } from '../src/core/commands.ts';
import { cleanup, copyFixture, INPUTS, REPO } from './helpers.ts';

describe('stage F: npm package', () => {
  it('the build compiles src to dist with .js imports, and the CLI runs from it', () => {
    const tsc = spawnSync('tsc', ['--version'], { encoding: 'utf8' });
    if (tsc.status !== 0) return; // no TypeScript compiler here
    const out = join(REPO, 'dist-test');
    const r = spawnSync('tsc', ['-p', 'tsconfig.build.json', '--outDir', out], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    try {
      const cli = readFileSync(join(out, 'cli.js'), 'utf8');
      assert.doesNotMatch(cli, /from '\.[^']*\.ts'/);
      const v = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(join(out, 'cli.js'))}).then(async (m) => process.exit(await m.main(['--version'])))`], { encoding: 'utf8' });
      assert.equal(v.stdout.trim(), JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version, v.stderr);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('package.json ships dist and bin for Node 20+, not the TypeScript source', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.engines, { node: '>=20' });
    assert.ok(pkg.files.includes('dist') && pkg.files.includes('bin') && !pkg.files.includes('src'));
    assert.match(pkg.scripts.prepublishOnly, /npm run build/);
  });
});

describe('stage F: VS Code extension', () => {
  /** Loads extension.js with a stand-in vscode module that records what it registers. */
  function loadExtension() {
    const registered: string[] = [];
    const fake = {
      window: { createOutputChannel: () => ({ appendLine() {}, clear() {}, show() {}, dispose() {} }) },
      languages: { createDiagnosticCollection: () => ({ clear() {}, set() {}, dispose() {} }) },
      workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ get: () => undefined }) },
      commands: { registerCommand: (id: string) => (registered.push(id), { dispose() {} }) },
    };
    const original = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
    (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = (request: string, ...rest: unknown[]) => (request === 'vscode' ? fake : original(request, ...rest));
    try {
      const ext = createRequire(import.meta.url)(join(REPO, 'extensions/vscode/extension.js'));
      ext.activate({ subscriptions: [] });
      return { ext, registered };
    } finally {
      (Module as unknown as { _load: unknown })._load = original;
    }
  }

  it('registers exactly the commands its package.json contributes', () => {
    const { registered } = loadExtension();
    const pkg = JSON.parse(readFileSync(join(REPO, 'extensions/vscode/package.json'), 'utf8'));
    assert.deepEqual(registered.sort(), pkg.contributes.commands.map((c: { command: string }) => c.command).sort());
  });

  it('turns doctor findings into Problems entries and a plan into one diff document', () => {
    const { ext } = loadExtension();
    assert.deepEqual(ext.findingsToProblems([{ check: 'urls', severity: 'warning', file: 'lib/a.ts', line: 3, message: 'Hardcoded URL', fix: 'Use the env' }, { check: 'locales', severity: 'info', message: 'no file' }]), [
      { file: 'lib/a.ts', line: 2, severity: 'warning', message: 'Hardcoded URL\nFix: Use the env', source: 'codz (urls)' },
    ]);
    const text = ext.planText({ id: 'p1', skill: 'api add', summary: ['Create a.ts'], warnings: ['careful'], files: [{ diff: '--- a\n+++ b\n' }] });
    assert.match(text, /^# api add: plan p1\n# • Create a\.ts\n# ! careful\n\n--- a/);
  });
});
