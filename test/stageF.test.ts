// Stage F: reach. The MCP server, the npm build, the VS Code extension.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { COMMAND_LIST } from '../src/core/commands.ts';
import { cliArgs, handleMessage, mcpTools } from '../src/skills/mcp.ts';
import { cleanup, copyFixture, INPUTS, REPO } from './helpers.ts';

describe('stage F: MCP server', () => {
  it('every command except terminal-only ones is a tool, with a JSON schema from its options', () => {
    const tools = mcpTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('api_add') && names.includes('api_sync') && names.includes('apply') && names.includes('doctor'));
    assert.ok(!names.includes('completion') && !names.includes('mcp') && !names.includes('init'));
    assert.equal(tools.length, COMMAND_LIST.filter((c) => !['completion', 'init', 'mcp', 'login', 'logout'].includes(c.cmd)).length);
    const add = tools.find((t) => t.name === 'api_add')!;
    assert.deepEqual(add.inputSchema.properties.sample, { type: 'array', items: { type: 'string' }, description: 'Response sample; repeat for several samples' });
    assert.equal((add.inputSchema.properties['no-unwrap'] as { type: string }).type, 'boolean');
    assert.ok(!('dry-run' in add.inputSchema.properties) && !('yes' in add.inputSchema.properties), 'tools never apply by themselves');
    assert.match(add.description, /nothing is written until you call apply/);
  });

  it('tool calls become CLI arguments; edits always get --plan', () => {
    const tools = mcpTools();
    const t = (n: string) => tools.find((x) => x.name === n)!;
    assert.deepEqual(cliArgs(t('api_add'), { url: 'https://a.dev/x', sample: ['a.json', 'b.json'] }), ['api', 'add', '--url', 'https://a.dev/x', '--sample', 'a.json', '--sample', 'b.json', '--plan', '--json', '--no-color']);
    assert.deepEqual(cliArgs(t('api_list'), {}), ['api', 'list', '--json', '--no-color']);
    assert.deepEqual(cliArgs(t('apply'), { args: ['20260101-000000-abcdef'] }), ['apply', '20260101-000000-abcdef', '--json', '--no-color']);
    assert.deepEqual(cliArgs(t('doctor'), {}), ['doctor', '--json', '--no-color'], 'plain doctor is read-only');
    assert.ok(cliArgs(t('doctor'), { fix: true }).includes('--plan'));
    assert.ok(!cliArgs(t('api_sync'), { args: ['s.yaml'], check: true }).includes('--plan'));
    assert.throws(() => cliArgs(t('api_list'), { yes: true }), /Unknown argument "yes"/);
  });

  it('answers the protocol: initialize, tools/list, resources, unknown methods', () => {
    const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, REPO, '0.1.0') as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'devtool');
    assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, REPO, '0.1.0'), null);
    const list = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, REPO, '0.1.0') as { result: { tools: { name: string; inputSchema: object }[] } };
    assert.ok(list.result.tools.every((t) => t.inputSchema && !('spec' in t)));
    const res = handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'devtool://commands' } }, REPO, '0.1.0') as { result: { contents: { text: string }[] } };
    assert.match(res.result.contents[0].text, /^# devtool commands/);
    const bad = handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }, REPO, '0.1.0') as { error: { code: number } };
    assert.equal(bad.error.code, -32601);
  });

  it('over stdio: plan with api_add, then apply writes exactly that plan', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const child = spawn(process.execPath, [join(REPO, 'bin/devtool.js'), 'mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      const replies = new Map<number, { result?: { content: { text: string }[]; isError: boolean } }>();
      let buf = '';
      const waiters = new Map<number, () => void>();
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const m = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          replies.set(m.id, m);
          waiters.get(m.id)?.();
        }
      });
      const send = (id: number, method: string, params: object) =>
        new Promise<NonNullable<ReturnType<typeof replies.get>>>((resolve) => {
          waiters.set(id, () => resolve(replies.get(id)!));
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      await send(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      const planned = await send(2, 'tools/call', { name: 'api_add', arguments: { url: 'https://api.example.com/orders', sample: [join(INPUTS, 'products.json')] } });
      const plan = JSON.parse(planned.result!.content[0].text);
      assert.equal(planned.result!.isError, false);
      assert.match(plan.planId, /^\d{8}-\d{6}-[0-9a-f]{6}$/);
      assert.equal(existsSync(join(dir, 'lib/api/orders.ts')), false, 'planning wrote nothing');
      const applied = await send(3, 'tools/call', { name: 'apply', arguments: { args: [plan.planId], 'allow-dirty': true, 'no-verify': true } });
      assert.equal(JSON.parse(applied.result!.content[0].text).applied, true);
      assert.ok(existsSync(join(dir, 'lib/api/orders.ts')));
      const failed = await send(4, 'tools/call', { name: 'api_show', arguments: { args: ['nope'] } });
      assert.equal(failed.result!.isError, true);
      child.stdin.end();
      await new Promise((r) => child.on('close', r));
    } finally {
      cleanup(dir);
    }
  });
});

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
      assert.equal(v.stdout.trim(), '0.1.0', v.stderr);
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
      { file: 'lib/a.ts', line: 2, severity: 'warning', message: 'Hardcoded URL\nFix: Use the env', source: 'devtool (urls)' },
    ]);
    const text = ext.planText({ id: 'p1', skill: 'api add', summary: ['Create a.ts'], warnings: ['careful'], files: [{ diff: '--- a\n+++ b\n' }] });
    assert.match(text, /^# api add: plan p1\n# • Create a\.ts\n# ! careful\n\n--- a/);
  });
});
