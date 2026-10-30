// Stage E: engineering health. The command table drives help, completion,
// flag parsing and docs; parsers survive malformed input.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main, parseArgs, VERSION } from '../src/cli.ts';
import { COMMAND_LIST, FLAGS, findCommand, renderHelp, renderMarkdown } from '../src/core/commands.ts';
import { COMMANDS } from '../src/skills/completion.ts';
import { REPO } from './helpers.ts';

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, '--no-color']);
    return { code, out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

const CLI_SOURCE = readFileSync(join(REPO, 'src/cli.ts'), 'utf8');

describe('stage E: one command table', () => {
  it('every command the CLI handles is in the table, and every flag it reads is defined', () => {
    const handled = new Set([...CLI_SOURCE.matchAll(/case '([a-z]+)':/g), ...CLI_SOURCE.matchAll(/cmd === '([a-z]+)'/g)].map((m) => m[1]).filter((c) => c !== 'help'));
    for (const c of handled) assert.ok(findCommand(c), `codz ${c} is handled but not in COMMAND_LIST`);
    const read = new Set([...CLI_SOURCE.matchAll(/flags\.([a-z]+)\b|flags\['([a-z-]+)'\]|multi\.([a-z]+)\b|multi\['([a-z-]+)'\]/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]));
    for (const f of read) assert.ok(FLAGS[f], `--${f} is read by the CLI but not in FLAGS`);
  });

  it('every flag a command lists exists, and completion offers exactly the table', () => {
    for (const c of COMMAND_LIST) for (const f of c.flags) assert.ok(FLAGS[f], `${c.cmd} ${c.sub ?? ''}: unknown flag ${f}`);
    for (const c of COMMAND_LIST) {
      const entry = COMMANDS[c.cmd];
      assert.ok(entry, c.cmd);
      if (c.sub) assert.ok(entry.subs?.[c.sub], `${c.cmd} ${c.sub}`);
    }
  });

  it('help lists every command; each command has its own help', async () => {
    const help = renderHelp(VERSION, 'codz.config.yaml');
    for (const c of COMMAND_LIST) assert.ok(help.includes(`codz ${c.cmd}${c.sub ? ` ${c.sub}` : ''}`), `${c.cmd} ${c.sub ?? ''} missing from help`);
    const r = await cli(['api', 'sync', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^codz api sync <file>/);
    assert.match(r.out, /--check +Report drift/);
    assert.match((await cli(['help', 'test', 'add'])).out, /^codz test add/);
  });

  it('a mistyped option is an error with a suggestion, not silently ignored', async () => {
    const r = await cli(['api', 'add', '--url', 'https://x.dev/a', '--dryrun']);
    assert.equal(r.code, 1);
    assert.match(r.err, /codz api add has no option --dryrun/);
    assert.match(r.err, /Did you mean --dry-run\?/);
    assert.match((await cli(['doctor', '--form'])).err, /has no option --form/);
  });

  it('the parser knows which flags take values and which repeat', () => {
    const a = parseArgs(['api', 'add', '--sample', 'a.json', '--sample', 'b.json', '--dry-run', '--name', 'x', '--tag=t1']);
    assert.deepEqual(a.multi.sample, ['a.json', 'b.json']);
    assert.equal(a.flags['dry-run'], true);
    assert.equal(a.flags.name, 'x');
    assert.deepEqual(a.multi.tag, ['t1']);
  });

  it('docs/COMMANDS.md is up to date (npm run docs)', () => {
    assert.equal(readFileSync(join(REPO, 'docs/COMMANDS.md'), 'utf8'), renderMarkdown(VERSION));
  });
});
