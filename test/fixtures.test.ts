// Golden tests: every scenario runs a skill against a fixture project and
// compares the planned files, summary and warnings with files in test/golden.
// Update them on purpose with: npm run test:update-golden

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { planApiAdd, type ApiAddOptions } from '../src/skills/apiAdd.ts';
import { cleanup, copyFixture, golden, input, INPUTS, REPO } from './helpers.ts';
import { detect } from '../src/detector.ts';

interface Scenario {
  name: string;
  fixture: string;
  opts: () => ApiAddOptions;
}

const sample = (f: string) => join(INPUTS, f);

const SCENARIOS: Scenario[] = [
  { name: 'nextjs-helper/order-from-curl', fixture: 'nextjs-helper', opts: () => ({ paste: input('order-curl.txt') }) },
  { name: 'nextjs-helper/products-list', fixture: 'nextjs-helper', opts: () => ({ url: 'https://api.example.com/products?category=home&page=1', samples: [sample('products.json')] }) },
  { name: 'nextjs-helper/delete-user', fixture: 'nextjs-helper', opts: () => ({ curl: 'curl -X DELETE https://api.example.com/users/5' }) },
  { name: 'nextjs-plain/team-detail', fixture: 'nextjs-plain', opts: () => ({ url: 'https://api.acme.dev/v1/teams/7f3e9d2a-1b4c-4e5f-8a9b-0c1d2e3f4a5b', samples: [sample('team-1.json'), sample('team-2.json')], modelName: 'TeamDetail' }) },
  { name: 'flutter-riverpod/order-from-curl', fixture: 'flutter-riverpod', opts: () => ({ paste: input('order-curl.txt') }) },
  { name: 'flutter-riverpod/products-list', fixture: 'flutter-riverpod', opts: () => ({ url: 'https://api.example.com/products?category=home', samples: [sample('products.json')] }) },
  { name: 'flutter-getit/visit-from-curl', fixture: 'flutter-getit', opts: () => ({ paste: input('visit-curl.txt') }) },
  { name: 'flutter-bloc-retrofit/project-members', fixture: 'flutter-bloc-retrofit', opts: () => ({ url: 'https://api.taskboard.dev/v1/projects/{projectId}/members?role=admin', samples: [sample('products.json')] }) },
  { name: 'nextjs-axios/deal-notes', fixture: 'nextjs-axios', opts: () => ({ url: 'https://api.crm.dev/v1/deals/{dealId}/notes?page=1', samples: [sample('products.json')] }) },
  { name: 'nextjs-axios/update-contact', fixture: 'nextjs-axios', opts: () => ({ curl: `curl -X PATCH https://api.crm.dev/v1/contacts/4 -d '{"name":"Bo"}'`, name: 'updateContact', samples: [sample('user.json')], modelName: 'UpdatedContact' }) },
];

describe('project scans (golden)', () => {
  for (const fixture of ['nextjs-helper', 'nextjs-plain', 'nextjs-axios', 'flutter-riverpod', 'flutter-getit', 'flutter-bloc-retrofit']) {
    it(fixture, async () => {
      const dir = copyFixture(fixture);
      try {
        const [d] = detect(dir);
        const { map } = await loadMap(dir, ADAPTERS[d.framework], {});
        golden(`maps/${fixture}.json`, JSON.stringify(map, null, 2) + '\n');
      } finally {
        cleanup(dir);
      }
    });
  }
});

describe('api add (golden)', () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const dir = copyFixture(s.fixture);
      try {
        const adapter = ADAPTERS[detect(dir)[0].framework];
        const { changeSet } = await planApiAdd(dir, adapter, s.opts());
        golden(`${s.name}/_summary.txt`, [...changeSet.summary.map((x) => `• ${x}`), ...changeSet.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
        for (const c of changeSet.changes) golden(`${s.name}/${c.path}`, c.after ?? "");
      } finally {
        cleanup(dir);
      }
    });
  }

  it('is deterministic: the same input twice gives the same files', async () => {
    const plans = [];
    for (let i = 0; i < 2; i++) {
      const dir = copyFixture('flutter-riverpod');
      try {
        const { changeSet } = await planApiAdd(dir, ADAPTERS.flutter, { paste: input('order-curl.txt') });
        plans.push(changeSet.changes.map((c) => [c.path, c.after]));
      } finally {
        cleanup(dir);
      }
    }
    assert.deepEqual(plans[0], plans[1]);
  });

  it('refuses a root model that clashes with an existing one', async () => {
    const dir = copyFixture('nextjs-plain');
    try {
      await assert.rejects(planApiAdd(dir, ADAPTERS.nextjs, { url: 'https://api.acme.dev/v1/teams/7f3e9d2a-1b4c-4e5f-8a9b-0c1d2e3f4a5b', samples: [sample('team-1.json')] }), /already has a model called Team/);
    } finally {
      cleanup(dir);
    }
  });

  it('reuses an existing model with the same fields', async () => {
    const dir = copyFixture('nextjs-plain');
    try {
      const { changeSet } = await planApiAdd(dir, ADAPTERS.nextjs, { url: 'https://api.acme.dev/v1/users/u9', samples: [sample('user.json')], path: '/v1/users/{id}', name: 'getUserById' });
      assert.ok(changeSet.changes.every((c) => c.path !== 'src/models/index.ts'));
      assert.ok(changeSet.warnings.some((w) => w.includes('Reusing the existing model User')));
    } finally {
      cleanup(dir);
    }
  });

  it('never writes secrets from the input', async () => {
    for (const fixture of ['nextjs-helper', 'flutter-riverpod']) {
      const dir = copyFixture(fixture);
      try {
        const { changeSet } = await planApiAdd(dir, ADAPTERS[detect(dir)[0].framework], { paste: input('order-curl.txt') });
        const all = changeSet.changes.map((c) => c.after).join('\n');
        assert.ok(!all.includes('eyJhbGc') && !all.includes('api_key') && !all.includes('abc'), fixture);
      } finally {
        cleanup(dir);
      }
    }
  });
});

describe('cli --json', () => {
  it('init, explain and a dry run produce machine-readable output', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const run = (...args: string[]) => {
        const r = spawnSync(process.execPath, [join(REPO, 'bin/devtool.js'), ...args, '--json', '--cwd', dir], { encoding: 'utf8', input: '' });
        return JSON.parse(r.stdout);
      };
      const init = run('init');
      assert.equal(init.ok, true);
      assert.equal(init.framework, 'nextjs');
      const explain = run('explain');
      assert.equal(explain.map.endpoints.length, 2);
      const dry = run('api', 'add', '--curl', 'curl https://api.example.com/users/5/settings', '--dry-run');
      assert.equal(dry.applied, false);
      assert.equal(dry.changeSet.files[0].path, 'lib/api/users.ts');
      const bad = run('api', 'add', '--dry-run');
      assert.equal(bad.ok, false);
      assert.equal(bad.error.code, 'no_input');
    } finally {
      cleanup(dir);
    }
  });
});
