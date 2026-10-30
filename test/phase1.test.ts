// Roadmap phase 1: api list/show, config view/set/check, plans, completion and
// doctor --setup.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet, savePlan } from '../src/core/changeset.ts';
import { validateConfig } from '../src/core/validateConfig.ts';
import { main } from '../src/cli.ts';
import { apiList, apiShow } from '../src/skills/apiList.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { complete, completionScript, FILES } from '../src/skills/completion.ts';
import { configCheck, configView, planConfigSet } from '../src/skills/config.ts';
import { cleanPlans, listPlans } from '../src/skills/plans.ts';
import { runSetupDoctor } from '../src/skills/setupDoctor.ts';
import { cleanup, copyFixture, INPUTS } from './helpers.ts';

const { nextjs, flutter } = ADAPTERS;

const CONFIG = `# codz configuration. Commit this file.
framework: nextjs
conventions:
  # where API functions live
  apiFolder: lib/api
  # string quote: single or double
  quote: single # keep this comment
  semicolons: 'true'
`;

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

describe('api list / api show', () => {
  it('lists endpoints sorted by path and filters them', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const all = await apiList(dir, nextjs);
      assert.deepEqual(all.map((e) => e.name), ['getUser', 'updateUser']);
      assert.equal(all.find((e) => e.name === 'updateUser')!.uses, 0);
      assert.deepEqual((await apiList(dir, nextjs, { filter: 'patch' })).map((e) => e.name), ['updateUser']);
    } finally {
      cleanup(dir);
    }
  });

  it('shows the signature, the models and every use', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const d = await apiShow(dir, nextjs, 'getUser');
      assert.equal(d.signature, 'export function getUser(id: number): Promise<User>');
      assert.deepEqual(d.models.map((m) => m.name), ['User']);
      assert.ok(d.uses.some((u) => u.file === 'app/profile/page.tsx' && /getUser\(1\)/.test(u.text)));
      await assert.rejects(apiShow(dir, nextjs, 'getUsr'), /No endpoint called getUsr/);
    } finally {
      cleanup(dir);
    }
  });

  it('works for Flutter repositories', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      const d = await apiShow(dir, flutter, 'getUser');
      assert.match(d.signature ?? '', /Future<UserModel> getUser\(int id\) async/);
      assert.ok(d.uses.some((u) => u.file === 'lib/features/profile/profile_page.dart'));
    } finally {
      cleanup(dir);
    }
  });
});

describe('config', () => {
  it('validateConfig reports tabs, unknown keys, bad values and paths outside the project', () => {
    assert.match(validateConfig('framework: nextjs\nconventions:\n\tquote: single\n')[0].message, /tab/);
    const issues = validateConfig('framework: nextjs\nconventions:\n  quote: triple\n  qoute: single\n  apiFolder: ../elsewhere\n  extra: x\n', '/tmp/project');
    assert.deepEqual(issues.map((i) => [i.level, i.key]), [['error', 'quote'], ['warning', 'qoute'], ['error', 'apiFolder'], ['warning', 'extra']]);
    assert.equal(validateConfig('framework: vue\n')[0].key, 'framework');
    assert.deepEqual(validateConfig(CONFIG), []);
  });

  it('set replaces a value in place and keeps comments and order', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      const cs = planConfigSet(dir, nextjs, 'quote', 'double');
      assert.equal(cs.changes[0].after!, CONFIG.replace('quote: single # keep this comment', 'quote: double # keep this comment'));
    } finally {
      cleanup(dir);
    }
  });

  it('set adds a missing key with its description, and refuses bad values and unknown keys', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      const cs = planConfigSet(dir, nextjs, 'modelsFolder', 'src/types');
      assert.match(cs.changes[0].after!, /semicolons: 'true'\n {2}# where TypeScript interfaces for API data live\n {2}modelsFolder: src\/types\n$/);
      assert.throws(() => planConfigSet(dir, nextjs, 'quote', 'backtick'), /not one of: single, double/);
      assert.throws(() => planConfigSet(dir, nextjs, 'qoute', 'single'), (e: { hint?: string }) => /Did you mean quote\?/.test(e.hint ?? ''));
      assert.throws(() => planConfigSet(dir, nextjs, 'apiFolder', '../../etc'), /outside the project/);
    } finally {
      cleanup(dir);
    }
  });

  it('set applies through the normal pipeline and undo restores it', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      assert.equal((await cli(['--root', dir, 'config', 'set', 'quote', 'double', '--yes', '--no-color'])).code, 0);
      assert.match(readFileSync(join(dir, 'codz.config.yaml'), 'utf8'), /quote: double/);
      assert.equal((await configView(dir, nextjs)).rows.find((r) => r.key === 'quote')!.value, 'double');
      assert.equal((await cli(['--root', dir, 'undo'])).code, 0);
      assert.equal(readFileSync(join(dir, 'codz.config.yaml'), 'utf8'), CONFIG);
    } finally {
      cleanup(dir);
    }
  });

  it('view marks which values come from the config and which were detected', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      const v = await configView(dir, nextjs);
      assert.equal(v.rows.find((r) => r.key === 'quote')!.source, 'config');
      assert.equal(v.rows.find((r) => r.key === 'httpHelper')!.source, 'detected');
      assert.equal(v.rows.find((r) => r.key === 'httpHelper')!.value, 'apiFetch');
    } finally {
      cleanup(dir);
    }
  });

  it('check exits 1 on errors, and a broken config is a clear error, not a crash', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), 'framework: nextjs\nconventions:\n  quote: triple\n');
      assert.equal(configCheck(dir).issues[0].key, 'quote');
      const r = await cli(['--root', dir, 'config', 'check', '--json']);
      assert.equal(r.code, 1);
      assert.equal(JSON.parse(r.out).valid, false);
      writeFileSync(join(dir, 'codz.config.yaml'), 'framework: nextjs\nconventions\n');
      const broken = await cli(['--root', dir, 'explain', '--json']);
      assert.equal(JSON.parse(broken.out).error.code, 'bad_config');
    } finally {
      cleanup(dir);
    }
  });
});

describe('plans', () => {
  it('ready, applied and stale; clean removes the last two', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const a = (await planApiAdd(dir, nextjs, { url: 'https://api.example.com/orders', samples: [join(INPUTS, 'products.json')] })).changeSet;
      const b = (await planApiAdd(dir, nextjs, { url: 'https://api.example.com/teams', samples: [join(INPUTS, 'team-1.json')] })).changeSet;
      savePlan(dir, a);
      savePlan(dir, b);
      assert.deepEqual(listPlans(dir).map((p) => p.status), ['ready', 'ready']);
      applyChangeSet(dir, a, { allowDirty: true, verify: false, format: false });
      const status = Object.fromEntries(listPlans(dir).map((p) => [p.id, p.status]));
      assert.equal(status[a.id], 'applied');
      assert.equal(status[b.id], 'stale'); // both touch lib/api/index.ts
      assert.deepEqual(cleanPlans(dir).sort(), [a.id, b.id].sort());
      assert.deepEqual(listPlans(dir), []);
    } finally {
      cleanup(dir);
    }
  });
});

describe('completion', () => {
  it('completes commands, subcommands, flags, endpoint names, config keys and values', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      assert.ok((await complete([''], dir, nextjs)).includes('api'));
      assert.ok((await complete(['api', ''], dir, nextjs)).includes('show'));
      assert.deepEqual(await complete(['api', 'show', ''], dir, nextjs), ['getUser', 'updateUser']);
      assert.ok((await complete(['api', 'add', '--'], dir, nextjs)).includes('--sample'));
      assert.deepEqual(await complete(['api', 'add', '--sample', ''], dir, nextjs), [FILES]);
      assert.deepEqual(await complete(['config', 'set', 'quote', ''], dir, nextjs), ['single', 'double']);
      assert.deepEqual(await complete(['doctor', '--only', ''], dir, nextjs), ['locales', 'api', 'urls', 'models']);
    } finally {
      cleanup(dir);
    }
  });

  it('prints scripts for bash, zsh and fish that call __complete', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) assert.match(completionScript(shell), /codz __complete/);
    const r = await cli(['completion', 'zsh']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^#compdef codz/);
    const c = await cli(['__complete', 'api', 'add', '--sa']); // a half-typed flag must not error
    assert.equal(c.code, 0);
    assert.match(c.out, /--sample/);
  });
});

describe('doctor --setup', () => {
  it('passes on a set-up project and fails without a config', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      let r = runSetupDoctor(dir, nextjs);
      const byId = (id: string) => r.checks.find((c) => c.id === id)!;
      assert.equal(byId('node_version').status, 'pass');
      assert.equal(byId('config_found').status, 'fail');
      writeFileSync(join(dir, 'codz.config.yaml'), CONFIG);
      r = runSetupDoctor(dir, nextjs);
      assert.equal(byId('config_found').status, 'pass');
      assert.equal(byId('config_valid').status, 'pass');
      assert.equal(byId('framework_supported').status, 'pass');
      assert.deepEqual(r.checks.map((c) => c.id), ['node_version', 'git_present', 'git_clean', 'config_found', 'config_valid', 'config_paths', 'gitignore', 'framework_supported', 'unsupported_libs', 'formatter', 'analyzer', 'scan_cache', 'history_state']);
    } finally {
      cleanup(dir);
    }
  });

  it('reports a broken config, missing paths, unsupported libraries and leftover temp files', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      writeFileSync(join(dir, 'codz.config.yaml'), 'framework: flutter\nconventions:\n  di: dagger\n  networkFile: lib/missing.dart\n');
      writeFileSync(join(dir, 'pubspec.yaml'), readFileSync(join(dir, 'pubspec.yaml'), 'utf8').replace('dependencies:', 'dependencies:\n  chopper: ^8.0.0'));
      mkdirSync(join(dir, 'lib'), { recursive: true });
      writeFileSync(join(dir, 'lib/main.dart.codz-tmp'), 'x');
      const r = runSetupDoctor(dir, flutter);
      const byId = (id: string) => r.checks.find((c) => c.id === id)!;
      assert.equal(byId('config_valid').status, 'fail');
      assert.match(byId('config_valid').message, /dagger/);
      assert.equal(byId('config_paths').status, 'warn');
      assert.match(byId('unsupported_libs').message, /Chopper/);
      assert.equal(byId('history_state').status, 'fail');
      const cliRun = await cli(['--root', dir, 'doctor', '--setup', '--json']);
      assert.equal(cliRun.code, 1);
      assert.equal(JSON.parse(cliRun.out).summary.fail, 2);
    } finally {
      cleanup(dir);
    }
  });
});
