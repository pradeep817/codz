// Every common command on every sample project, applied for real: none may
// crash ("This is a codz bug"), none may replace an existing file it should
// only edit (unsafe_rewrite), every refusal must say what to do next, and undo
// must take the whole session back.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import { readHistory } from '../src/core/changeset.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const EXAMPLE = join(REPO, 'examples', 'openapi.yaml');
const CHANGE = ['--yes', '--allow-dirty', '--no-verify', '--no-format'];

const SESSION: string[][] = [
  ['init', '--yes'],
  ['feature', 'add', 'products', '--spec', EXAMPLE, '--no-install', ...CHANGE],
  ['feature', 'add', 'orders', '--spec', EXAMPLE, '--no-install', ...CHANGE],
  ['screen', 'add', 'order-tracking', '--api', 'getOrderTracking', '--path', '/orders/:orderId/tracking', ...CHANGE],
  ['route', 'add', 'settings', ...CHANGE],
  ['auth', 'add', ...CHANGE],
  ['api', 'import', EXAMPLE, '--skip-conflicts', ...CHANGE],
  ['api', 'sync', EXAMPLE, '--check'],
  ['mock', 'add', '--all', ...CHANGE],
  ['test', 'add', '--all', ...CHANGE],
  ['theme', 'set', 'primary', '#0F766E', ...CHANGE],
  ['locale', 'key', 'greeting', 'Hello', ...CHANGE],
  ['doctor'],
  ['explain'],
  ['api', 'list'],
  ['report'],
];

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.codz' || name === 'codz.config.yaml') continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(root, abs), readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

async function run(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((out += s), true)) as typeof process.stderr.write;
  try {
    return { code: await main([...args, '--cwd', dir, '--no-color']), out };
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
}

const FIXTURES = readdirSync(join(REPO, 'fixtures')).filter((f) => statSync(join(REPO, 'fixtures', f)).isDirectory());

describe('every command on every sample project', () => {
  for (const fixture of FIXTURES) {
    it(fixture, async () => {
      const dir = copyFixture(fixture);
      try {
        // init writes the config and adds .codz/ to .gitignore; it is not a change to undo.
        await run(dir, ['init', '--yes']);
        const before = snapshot(dir);
        for (const args of SESSION.slice(1)) {
          const { code, out } = await run(dir, args);
          const what = `codz ${args.slice(0, 3).join(' ')} on ${fixture}`;
          assert.doesNotMatch(out, /This is a codz bug/, `${what} crashed:\n${out.slice(-1500)}`);
          assert.doesNotMatch(out, /instead of editing (it|them)/, `${what} would replace an existing file:\n${out.slice(-800)}`);
          if (code !== 0 && /^✗ /m.test(out)) {
            // A refusal names the problem and the next step (the indented line under it).
            const msg = out.slice(out.search(/^✗ /m));
            assert.match(msg, /^✗ .+\n {2}\S/m, `${what} refused without saying what to do:\n${msg.slice(0, 400)}`);
          }
        }
        // Undo the whole session.
        for (let i = readHistory(dir).filter((h) => !h.undone).length; i > 0; i--) {
          const { code, out } = await run(dir, ['undo']);
          assert.equal(code, 0, out);
        }
        assert.deepEqual([...snapshot(dir).keys()].sort(), [...before.keys()].sort(), `${fixture}: undo left files behind or missing`);
        for (const [path, text] of before) assert.equal(snapshot(dir).get(path), text, `${fixture}: ${path} differs after undo`);
      } finally {
        cleanup(dir);
      }
    });
  }
});
