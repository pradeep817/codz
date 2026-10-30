// codz new and the starter catalog: strict parsing, hostile archives,
// signatures, the engine, the local flow (new → init → api add → undo), and
// the online flow against a fake registry (index, rollback, expiry,
// revocation, login, entitlement, cache).

import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { main } from '../src/cli.ts';
import { addPubspecEntries, planNew, substitute } from '../src/starters/engine.ts';
import { parseManifest, resolveAnswers, satisfies } from '../src/starters/manifest.ts';
import { checkCollisions, checkRelPath, LIMITS } from '../src/starters/paths.ts';
import { buildIndex, checkTemplate, packTemplate, signTimestamp } from '../src/starters/publish.ts';
import { generateKeys, sha256, signatureFile, verifySignature } from '../src/starters/sign.ts';
import { fromArchive, fromFolder } from '../src/starters/source.ts';
import { parseStrictJson } from '../src/starters/strictJson.ts';
import { readTarGz, writeTarGz } from '../src/starters/tar.ts';
import { INPUTS, REPO } from './helpers.ts';

const STARTERS = join(REPO, 'starters');
const NEXT = join(STARTERS, 'nextjs-app-router-fetch');
const FLUTTER = join(STARTERS, 'flutter-riverpod-dio');

async function cli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  // Only text is codz's; the test runner talks to its parent with binary writes, which must pass through.
  process.stdout.write = ((s: string | Uint8Array, ...rest: unknown[]) => (typeof s === 'string' ? ((out += s), true) : (ow as (...a: unknown[]) => boolean)(s, ...rest))) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array, ...rest: unknown[]) => (typeof s === 'string' ? ((err += s), true) : (ew as (...a: unknown[]) => boolean)(s, ...rest))) as typeof process.stderr.write;
  try {
    const code = await main([...args, ...(cwd ? ['--cwd', cwd] : []), '--no-color']);
    return { code, out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
}

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `codz-${p}-`));
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, (e: { code?: string; message?: string }) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));

/** One raw ustar header + data, for archives the writer would never produce. */
function rawEntry(name: string, type: string, data = Buffer.alloc(0), linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644', 100, 8, 'ascii');
  h.write('0000000', 108, 8);
  h.write('0000000', 116, 8);
  h.write(data.length.toString(8).padStart(11, '0'), 124, 12);
  h.write('00000000000', 136, 12);
  h.write('        ', 148, 8);
  h.write(type, 156, 1);
  h.write(linkname, 157, 100);
  h.write('ustar\u0000', 257, 6, 'binary');
  h.write('00', 263, 2);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148, 8, 'binary');
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

// ---------------------------------------------------------------------------

describe('starters: strict parsing', () => {
  it('JSON: duplicate keys, deep nesting, trailing text and huge strings are refused', () => {
    rejects(() => parseStrictJson('{"a":1,"a":2}', 'x'), 'bad_template');
    rejects(() => parseStrictJson('[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]', 'x'), 'bad_template');
    rejects(() => parseStrictJson('{"a":1} x', 'x'), 'bad_template');
    rejects(() => parseStrictJson(JSON.stringify({ a: 'x'.repeat(70_000) }), 'x'), 'bad_template');
    assert.deepEqual(parseStrictJson('{"a":[1,"b\\n",true,null]}', 'x'), Object.assign(Object.create(null), { a: [1, 'b\n', true, null] }));
  });

  it('manifest: unknown fields, steps off the allowlist, unsafe paths, overlay without org', () => {
    const base = JSON.parse(readFileSync(join(NEXT, 'manifest.json'), 'utf8'));
    const bad = (patch: Record<string, unknown>, code = 'bad_template') => rejects(() => parseManifest(JSON.stringify({ ...base, ...patch })), code);
    bad({ scripts: { postinstall: 'curl evil' } });
    bad({ steps: ['npm_install', 'run_anything'] });
    bad({ steps: ['flutter_pub_get'] });
    bad({ files: [{ path: '../../.ssh/config', sha256: 'a'.repeat(64), size: 1 }] }, 'archive_unsafe');
    bad({ files: [{ path: 'README.md', sha256: 'a'.repeat(64), size: 1 }, { path: 'readme.md', sha256: 'a'.repeat(64), size: 1 }] }, 'archive_unsafe');
    bad({ schema: 2 }, 'template_incompatible');
    const fl = JSON.parse(readFileSync(join(FLUTTER, 'manifest.json'), 'utf8'));
    rejects(() => parseManifest(JSON.stringify({ ...fl, answers: fl.answers.filter((a: { key: string }) => a.key !== 'org') })), 'bad_template');
    assert.equal(parseManifest(JSON.stringify(base)).id, 'nextjs-app-router-fetch');
  });

  it('paths: traversal, absolute, drive letters, reserved names, .git, case and file/folder collisions', () => {
    for (const p of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'con.txt', 'a/aux', 'x.', '.git/config', '.codz/history.json', 'a//b', './a']) rejects(() => checkRelPath(p, 't'), 'archive_unsafe');
    assert.equal(checkRelPath('lib/main.dart', 't'), 'lib/main.dart');
    rejects(() => checkCollisions(['a/B.txt', 'a/b.txt'], 't'), 'archive_unsafe');
    rejects(() => checkCollisions(['caf\u00e9', 'cafe\u0301'], 't'), 'archive_unsafe');
    rejects(() => checkCollisions(['lib', 'lib/x.dart'], 't'), 'archive_unsafe');
  });

  it('answers are typed: shell and code characters never get through', () => {
    const m = parseManifest(readFileSync(join(FLUTTER, 'manifest.json'), 'utf8'));
    for (const v of ['my app', 'x;rm -rf /', '$(id)', 'My_App', '../x']) rejects(() => resolveAnswers(m, { appName: v }), 'bad_answer');
    for (const v of ['A "quoted" title', "it's", 'x ${y}', '`id`', '{{org}}', 'a\nb']) rejects(() => resolveAnswers(m, { appTitle: v }), 'bad_answer');
    rejects(() => resolveAnswers(m, { org: 'acme' }), 'bad_answer');
    rejects(() => resolveAnswers(m, { nope: 'x' }), 'bad_answer');
    assert.equal(resolveAnswers(m, { appName: 'shop_app' }).appTitle, 'My App');
  });

  it('version ranges', () => {
    assert.ok(satisfies('3.27.1', '>=3.24 <4.0'));
    assert.ok(!satisfies('4.0.0', '>=3.24 <4.0'));
    assert.ok(satisfies('1.4.2', '^1.2.0') && !satisfies('2.0.0', '^1.2.0'));
    assert.ok(satisfies('0.1.0', '>=0.1.0') && !satisfies('0.0.9', '>=0.1.0'));
  });
});

describe('starters: archives', () => {
  it('the writer is deterministic and the reader reads it back', () => {
    const files = new Map([['b.txt', Buffer.from('b')], ['a/x.txt', Buffer.from('x')], [`${'directory-name/'.repeat(9)}long.txt`, Buffer.from('long path')]]);
    const one = writeTarGz(files, new Set(['b.txt']));
    const two = writeTarGz(new Map([...files].reverse()), new Set(['b.txt']));
    assert.equal(sha256(one), sha256(two));
    const back = readTarGz(one);
    assert.deepEqual([...back.files.keys()].sort(), [...files.keys()].sort());
    assert.equal(back.files.get(`${'directory-name/'.repeat(9)}long.txt`)!.toString(), 'long path');
  });

  it('hostile archives are refused before anything is written', () => {
    const cases: [Buffer, string][] = [
      [tgz(rawEntry('../evil', '0', Buffer.from('x'))), 'archive_unsafe'],
      [tgz(rawEntry('/etc/evil', '0', Buffer.from('x'))), 'archive_unsafe'],
      [tgz(rawEntry('link', '2', Buffer.alloc(0), '/etc/passwd')), 'archive_unsafe'],
      [tgz(rawEntry('hard', '1', Buffer.alloc(0), 'x')), 'archive_unsafe'],
      [tgz(rawEntry('dev', '3')), 'archive_unsafe'],
      [tgz(rawEntry('fifo', '6')), 'archive_unsafe'],
      [tgz(rawEntry('a.txt', '0', Buffer.from('1')), rawEntry('a.txt', '0', Buffer.from('2'))), 'archive_unsafe'],
      [tgz(rawEntry('pax', 'x', Buffer.from('30 linkpath=/etc/passwd/xxxxx\n')), rawEntry('a', '0')), 'archive_unsafe'],
      [tgz(rawEntry('pax', 'g', Buffer.from('16 comment=hello\n'))), 'archive_unsafe'],
      [tgz(rawEntry('././@LongLink', 'L', Buffer.from('../../x'))), 'archive_unsafe'],
      [tgz(rawEntry('A.txt', '0'), rawEntry('a.txt', '0')), 'archive_unsafe'],
      [Buffer.from('not gzip'), 'bad_template'],
      [gzipSync(rawEntry('cut.txt', '0', Buffer.alloc(2000)).subarray(0, 900)), 'bad_template'],
    ];
    for (const [gz, code] of cases) rejects(() => readTarGz(gz), code);
  });

  it('limits: entry count, expanded size (a decompression bomb) and compressed size', () => {
    const saved = { ...LIMITS };
    try {
      LIMITS.entries = 3;
      rejects(() => readTarGz(tgz(...['a', 'b', 'c', 'd'].map((n) => rawEntry(n, '0')))), 'archive_too_large');
      LIMITS.entries = saved.entries;
      LIMITS.expandedBytes = 64 * 1024;
      const bomb = gzipSync(Buffer.concat([rawEntry('zeros', '0', Buffer.alloc(4 * 1024 * 1024)), Buffer.alloc(1024)]));
      assert.ok(bomb.length < 20_000, 'a small archive that expands a lot');
      rejects(() => readTarGz(bomb), 'archive_too_large');
      LIMITS.compressedBytes = 100;
      rejects(() => readTarGz(bomb), 'archive_too_large');
    } finally {
      Object.assign(LIMITS, saved);
    }
  });

  it('template contents must match the manifest exactly: tampered, missing and extra files', () => {
    const t = fromFolder(NEXT);
    const entries = (patch: (m: Map<string, Buffer>) => void) => {
      const m = new Map<string, Buffer>([['manifest.json', t.manifestBytes], ['LICENSE', Buffer.from(t.license)], ...[...t.files].map(([p, d]): [string, Buffer] => [`files/${p}`, d])]);
      patch(m);
      return writeTarGz(m);
    };
    assert.equal(fromArchive(entries(() => {}), 'test').manifest.id, 'nextjs-app-router-fetch');
    rejects(() => fromArchive(entries((m) => m.set('files/app/page.tsx', Buffer.from('export default 1;'))), 'test'), 'checksum_mismatch');
    rejects(() => fromArchive(entries((m) => m.delete('files/README.md')), 'test'), 'checksum_mismatch');
    rejects(() => fromArchive(entries((m) => m.set('files/postinstall.sh', Buffer.from('curl x | sh'))), 'test'), 'checksum_mismatch');
    rejects(() => fromArchive(entries((m) => m.set('run.sh', Buffer.from('x'))), 'test'), 'archive_unsafe');
    rejects(() => fromArchive(entries((m) => m.delete('LICENSE')), 'test'), 'bad_template');
  });

  it('a template folder with a link is refused', { skip: process.platform === 'win32' }, async () => {
    const dir = tmp('link');
    try {
      cpSync(NEXT, dir, { recursive: true });
      const { symlinkSync } = await import('node:fs');
      symlinkSync('/etc/passwd', join(dir, 'files', 'passwd'));
      rejects(() => fromFolder(dir), 'archive_unsafe');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('starters: signatures', () => {
  it('Ed25519 over the exact bytes; wrong key, tampered bytes and empty trust all fail', () => {
    const k = generateKeys();
    const other = generateKeys();
    const data = Buffer.from('{"seq":1}\n');
    const sig = signatureFile(data, [k.privatePem]);
    assert.equal(verifySignature(data, sig, { [k.keyid]: k.publicRaw }, 'x'), k.keyid);
    rejects(() => verifySignature(Buffer.from('{"seq":2}\n'), sig, { [k.keyid]: k.publicRaw }, 'x'), 'signature_invalid');
    rejects(() => verifySignature(data, sig, { [other.keyid]: other.publicRaw }, 'x'), 'signature_invalid');
    rejects(() => verifySignature(data, sig, {}, 'x'), 'signature_invalid');
    // Two signatures during a key rotation: either trusted key is enough.
    const both = signatureFile(data, [other.privatePem, k.privatePem]);
    assert.equal(verifySignature(data, both, { [k.keyid]: k.publicRaw }, 'x'), k.keyid);
  });
});

describe('starters: engine', () => {
  it('placeholders: known keys only, in contents and paths; binary files untouched', () => {
    const v = new Map([['appName', 'shop'], ['org.path', 'com/acme']]);
    assert.equal(substitute('{{appName}} {{other}} {{ appName }} {{org.path}}', v), 'shop {{other}} {{ appName }} com/acme');
    const t = fromFolder(NEXT);
    const m = { ...t.manifest, files: [...t.manifest.files] };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x7b, 0x7b]);
    t.files.set('public/{{appName}}.png', png);
    m.files.push({ path: 'public/{{appName}}.png', sha256: sha256(png), size: png.length });
    const p = planNew({ ...t, manifest: m }, resolveAnswers(m, { appName: 'shop-web', appTitle: 'Shop' }), '/tmp/x', '0.1.0', null, { steps: true });
    assert.ok(p.files.some((f) => f.path === 'public/shop-web.png' && f.data.equals(png)));
    assert.match(p.files.find((f) => f.path === 'package.json')!.data.toString(), /"name": "shop-web"/);
    assert.match(p.files.find((f) => f.path === 'app/layout.tsx')!.data.toString(), /title: 'Shop'/);
    assert.deepEqual(p.steps.map((s) => s.command.slice(1)), [['install', '--ignore-scripts', '--no-audit', '--no-fund']]);
  });

  it('pubspec dependencies go after the SDK entries, sorted, without duplicates', () => {
    const t = 'name: x\n\ndependencies:\n  flutter:\n    sdk: flutter\n  cupertino_icons: ^1.0.8\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n';
    const out = addPubspecEntries(t, 'dependencies', { go_router: '^14.6.2', dio: '^5.7.0', cupertino_icons: '^1.0.0' });
    assert.equal(out, 'name: x\n\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.7.0\n  go_router: ^14.6.2\n  cupertino_icons: ^1.0.8\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n');
  });

  it('the internal starters pass the publishing gates (static, secrets, determinism)', () => {
    for (const dir of [NEXT, FLUTTER]) {
      const r = checkTemplate(dir, '0.1.0');
      assert.deepEqual(r.errors, [], `${r.id}: ${r.errors.join('; ')}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('starters: codz new from a folder', () => {
  it('new → init (conventions match the manifest) → api add → undo twice removes the project', async () => {
    const parent = tmp('new');
    try {
      const r = await cli(['new', 'shop-web', '--template', NEXT, '--set', 'appTitle=Shop Web', '--no-steps', '--yes'], parent);
      assert.equal(r.code, 0, r.err);
      const dir = join(parent, 'shop-web');
      assert.ok(!readdirSync(parent).some((n) => n.includes('codz-new')), 'no temporary folder left');
      assert.match(readFileSync(join(dir, 'app/layout.tsx'), 'utf8'), /title: 'Shop Web'/);
      assert.match(readFileSync(join(dir, 'package.json'), 'utf8'), /"next": "\^15/);
      assert.equal((await cli(['init', '--yes'], dir)).code, 0);
      const expected = JSON.parse(readFileSync(join(NEXT, 'manifest.json'), 'utf8')).expectedConventions as Record<string, string>;
      const cfg = readFileSync(join(dir, 'codz.config.yaml'), 'utf8');
      for (const [k, v] of Object.entries(expected)) assert.match(cfg, new RegExp(`^  ${k}: '?${v.replace(/[/@.]/g, '\\$&')}'?$`, 'm'), `init contract: ${k}`);
      const add = await cli(['api', 'add', '--url', 'https://api.example.com/products', '--sample', join(INPUTS, 'products.json'), '--yes', '--allow-dirty', '--no-verify'], dir);
      assert.equal(add.code, 0, add.err);
      assert.ok(existsSync(join(dir, 'lib/api/products.ts')));
      assert.match((await cli(['undo'], dir)).out, /Undid api add/);
      const u = await cli(['undo'], dir);
      assert.match(u.out, /Undid new/);
      assert.ok(!existsSync(dir));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('undo refuses after an edit (until --force); the target must be empty; dry-run writes nothing', async () => {
    const parent = tmp('new');
    try {
      const dry = await cli(['new', 'a', '--template', NEXT, '--dry-run', '--json'], parent);
      assert.equal(JSON.parse(dry.out).files.length, 13);
      assert.deepEqual(readdirSync(parent), []);
      assert.equal((await cli(['new', 'a', '--template', NEXT, '--no-steps', '--yes'], parent)).code, 0);
      writeFileSync(join(parent, 'a', 'app/page.tsx'), 'changed');
      const u = await cli(['undo', '--json'], join(parent, 'a'));
      assert.equal(JSON.parse(u.out).error.code, 'changed_since_apply');
      assert.equal((await cli(['undo', '--force'], join(parent, 'a'))).code, 0);
      mkdirSync(join(parent, 'b'));
      writeFileSync(join(parent, 'b', 'keep.txt'), 'x');
      assert.equal(JSON.parse((await cli(['new', 'b', '--template', NEXT, '--yes', '--json'], parent)).out).error.code, 'dir_not_empty');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('--json without --yes only plans; apply creates exactly that, and refuses when the template changed', async () => {
    const parent = tmp('new');
    const home = tmp('home');
    const tpl = tmp('tpl');
    process.env.CODZ_HOME = home;
    try {
      cpSync(NEXT, tpl, { recursive: true });
      const plan = JSON.parse((await cli(['new', 'p1', '--template', tpl, '--no-steps', '--json'], parent)).out);
      assert.ok(plan.planId);
      assert.ok(!existsSync(join(parent, 'p1')));
      assert.equal((await cli(['apply', plan.planId], parent)).code, 0);
      assert.ok(existsSync(join(parent, 'p1', 'app/page.tsx')));
      const plan2 = JSON.parse((await cli(['new', 'p2', '--template', tpl, '--no-steps', '--json'], parent)).out);
      writeFileSync(join(tpl, 'files', 'README.md'), 'changed\n');
      const { refreshFileList } = await import('../src/starters/publish.ts');
      refreshFileList(tpl);
      assert.equal(JSON.parse((await cli(['apply', plan2.planId, '--json'], parent)).out).error.code, 'changed_since_plan');
    } finally {
      delete process.env.CODZ_HOME;
      for (const d of [parent, home, tpl]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('Flutter overlay: runs flutter create first (a stand-in here), then the files and the dependencies', { skip: process.platform === 'win32' }, async () => {
    const parent = tmp('flutter');
    const bin = tmp('bin');
    const oldPath = process.env.PATH;
    try {
      // A stand-in flutter: create writes what flutter create would, the rest succeeds.
      writeFileSync(join(bin, 'flutter'), `#!/bin/sh
case "$1" in
  --version) echo '{"frameworkVersion":"3.27.1"}' ;;
  create) mkdir -p lib test android ios
    printf 'name: %s\\ndescription: x\\n\\nenvironment:\\n  sdk: ^3.6.0\\n\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  cupertino_icons: ^1.0.8\\n\\ndev_dependencies:\\n  flutter_test:\\n    sdk: flutter\\n  flutter_lints: ^5.0.0\\n\\nflutter:\\n  uses-material-design: true\\n' "$6" > pubspec.yaml
    echo "void main() {}" > lib/main.dart; echo "// counter test" > test/widget_test.dart; echo "$@" > android/created-with.txt ;;
  pub) touch pubspec.lock; mkdir -p .dart_tool ;;
esac
`);
      chmodSync(join(bin, 'flutter'), 0o755);
      writeFileSync(join(bin, 'dart'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'dart'), 0o755);
      process.env.PATH = `${bin}:${oldPath}`;
      const r = await cli(['new', 'shop_app', '--template', FLUTTER, '--org', 'com.acme', '--set', 'apiBaseUrl=https://api.shop.dev', '--yes'], parent);
      assert.equal(r.code, 0, r.err + r.out);
      const dir = join(parent, 'shop_app');
      assert.equal(readFileSync(join(dir, 'android/created-with.txt'), 'utf8').trim(), 'create --no-pub --org com.acme --project-name shop_app .');
      const pubspec = readFileSync(join(dir, 'pubspec.yaml'), 'utf8');
      assert.match(pubspec, /sdk: flutter\n {2}dio: \^5\.7\.0\n {2}flutter_riverpod: \^2\.6\.1\n {2}go_router: \^14\.6\.2\n {2}cupertino_icons/);
      assert.match(readFileSync(join(dir, 'lib/core/network/dio_provider.dart'), 'utf8'), /defaultValue: 'https:\/\/api\.shop\.dev'/);
      assert.match(readFileSync(join(dir, 'test/widget_test.dart'), 'utf8'), /import 'package:shop_app\/main\.dart';/);
      assert.equal((await cli(['init', '--yes'], dir)).code, 0);
      const cfg = readFileSync(join(dir, 'codz.config.yaml'), 'utf8');
      const expected = JSON.parse(readFileSync(join(FLUTTER, 'manifest.json'), 'utf8')).expectedConventions as Record<string, string>;
      for (const [k, v] of Object.entries(expected)) assert.match(cfg, new RegExp(`^  ${k}: '?${v.replace(/[/.]/g, '\\$&')}'?$`, 'm'), `init contract: ${k}`);
      const add = await cli(['api', 'add', '--url', 'https://api.shop.dev/products', '--sample', join(INPUTS, 'products.json'), '--yes', '--allow-dirty', '--no-verify', '--no-format'], dir);
      assert.equal(add.code, 0, add.err);
      assert.ok(existsSync(join(dir, 'lib/data/models/product.dart')));
      // pubspec.lock and .dart_tool from pub get, and codz.config.yaml from init, do not block undo.
      assert.match((await cli(['undo'], dir)).out, /Undid api add/);
      assert.match((await cli(['undo'], dir)).out, /Undid new/);
    } finally {
      process.env.PATH = oldPath;
      for (const d of [parent, bin]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('without Flutter an overlay starter stops before writing anything', async () => {
    const parent = tmp('noflutter');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = parent;
      const r = JSON.parse((await cli(['new', 'x_app', '--template', FLUTTER, '--yes', '--json'], parent)).out);
      assert.equal(r.error.code, 'sdk_missing');
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      process.env.PATH = oldPath;
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('starters: the catalog (fake registry)', () => {
  const keys = generateKeys();
  const reg = tmp('registry');
  const home = tmp('home');
  let server: Server;
  let base = '';
  const state = { revoked: false, serveOld: null as Buffer | null, tamper: false, owned: new Set<string>(['nextjs-pro']), approved: false, polls: 0, revokedTokens: [] as string[], announce: 0 };
  let oldIndex: Buffer;
  let oldSig: Buffer;

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<Record<string, string>>((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : {}));
  });

  before(async () => {
    // Publish: the free Next.js starter, a "paid" copy, and the index.
    packTemplate(NEXT, reg);
    const paid = tmp('paid');
    cpSync(NEXT, paid, { recursive: true });
    const pm = JSON.parse(readFileSync(join(paid, 'manifest.json'), 'utf8'));
    writeFileSync(join(paid, 'manifest.json'), JSON.stringify({ ...pm, id: 'nextjs-pro', title: 'Next.js Pro' }, null, 2));
    packTemplate(paid, reg);
    writeFileSync(join(paid, 'manifest.json'), JSON.stringify({ ...pm, id: 'nextjs-team', title: 'Next.js Team' }, null, 2));
    packTemplate(paid, reg);
    rmSync(paid, { recursive: true, force: true });
    writeFileSync(join(reg, 'catalog.json'), JSON.stringify({ templates: [{ id: 'nextjs-app-router-fetch', tier: 'free' }, { id: 'nextjs-pro', tier: 'paid', price: '$29' }, { id: 'nextjs-team', tier: 'paid', price: '$99' }] }));
    buildIndex(reg, [keys.privatePem]);
    oldIndex = readFileSync(join(reg, 'v1/index.json'));
    oldSig = readFileSync(join(reg, 'v1/index.json.sig'));
    buildIndex(reg, [keys.privatePem]); // seq 2 is current

    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      const auth = req.headers.authorization ?? '';
      if (url.pathname === '/v1/index.json' && state.serveOld) return send(res, 200, oldIndex);
      if (url.pathname === '/v1/index.json.sig' && state.serveOld) return send(res, 200, oldSig);
      if (req.method === 'GET' && url.pathname.startsWith('/v1/') && !url.pathname.startsWith('/v1/paid/') && url.pathname !== '/v1/me') {
        const file = join(reg, url.pathname);
        if (!existsSync(file) || url.pathname.includes('nextjs-pro') || url.pathname.includes('nextjs-team')) return send(res, 404, { error: 'not_found' });
        let data = readFileSync(file);
        if (state.tamper && file.endsWith('.tar.gz')) data = Buffer.concat([data, Buffer.from('x')]);
        return send(res, 200, data, 'application/octet-stream');
      }
      if (url.pathname === '/v1/paid/archive') {
        if (url.searchParams.get('sig') !== 'ok') return send(res, 403, {});
        return send(res, 200, readFileSync(join(reg, 'v1/templates', url.searchParams.get('id')!, '1.0.0', 'archive.tar.gz')), 'application/octet-stream');
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (url.pathname === '/v1/device/code') return send(res, 200, { device_code: 'dev-1', user_code: 'WXYZ-1234', verification_uri: `${base}/activate`, interval: 0, expires_in: 60 });
      if (url.pathname === '/v1/device/token') {
        state.polls++;
        if (state.polls < 2) return send(res, 400, { error: 'authorization_pending' });
        return send(res, 200, { access_token: 'access-secret-1', refresh_token: 'refresh-secret-1', expires_in: 900, account: 'dev@example.com' });
      }
      if (url.pathname === '/v1/token/revoke') {
        state.revokedTokens.push(body.refresh_token);
        return send(res, 200, {});
      }
      if (url.pathname === '/v1/me') return auth === 'Bearer access-secret-1' ? send(res, 200, { account: 'dev@example.com', owned: [...state.owned].map((id) => ({ id, updatesUntil: '2027-10-24' })) }) : send(res, 401, {});
      if (url.pathname === '/v1/download-url') {
        if (auth !== 'Bearer access-secret-1') return send(res, 401, {});
        if (!state.owned.has(body.id)) return send(res, 403, { error: 'no_entitlement' });
        return send(res, 200, { url: `${base}/v1/paid/archive?id=${body.id}&sig=ok` });
      }
      send(res, 404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.CODZ_REGISTRY = base;
    process.env.CODZ_REGISTRY_KEYS = keys.publicRaw;
    process.env.CODZ_HOME = home;
  });

  after(() => {
    server?.close();
    delete process.env.CODZ_REGISTRY;
    delete process.env.CODZ_REGISTRY_KEYS;
    delete process.env.CODZ_HOME;
    for (const d of [reg, home]) rmSync(d, { recursive: true, force: true });
  });

  it('starters list and show read the signed index; the network use is announced', async () => {
    const r = await cli(['starters', 'list']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nextjs-app-router-fetch +1\.0\.0 +nextjs +free/);
    assert.match(r.out, /nextjs-pro +1\.0\.0 +nextjs +paid \$29/);
    assert.match(r.err, /Contacting the starter catalog at 127\.0\.0\.1/);
    assert.match(r.err, /not the official one/);
    const show = await cli(['starters', 'show', 'nextjs-app-router-fetch']);
    assert.match(show.out, /Beyond codz create:\n {2}- Error and not-found pages/);
    assert.match(show.out, /codz new <name> --template nextjs-app-router-fetch@1\.0\.0/);
    assert.equal(JSON.parse((await cli(['starters', 'show', 'nope', '--json'])).out).error.code, 'template_not_found');
  });

  it('a free starter downloads, verifies, caches, and then works with --cached', async () => {
    const parent = tmp('cat');
    try {
      const r = await cli(['new', 'web', '--template', 'nextjs-app-router-fetch@1.0.0', '--no-steps', '--yes'], parent);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /verified, archive [0-9a-f]{12}/);
      assert.ok(existsSync(join(home, 'starters/cache/nextjs-app-router-fetch/1.0.0/archive.tar.gz')));
      const hist = JSON.parse(readFileSync(join(parent, 'web/.codz/history.json'), 'utf8'));
      assert.equal(hist[0].meta.starter.archiveSha256.length, 64);
      const off = await cli(['new', 'web2', '--template', 'nextjs-app-router-fetch', '--cached', '--no-steps', '--yes'], parent);
      assert.equal(off.code, 0, off.err);
      assert.doesNotMatch(off.err, /Contacting/);
      assert.equal(JSON.parse((await cli(['new', 'w3', '--template', 'nextjs-pro', '--cached', '--json', '--yes'], parent)).out).error.code, 'offline_not_cached');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('a download that does not match the signed index is refused and not cached', async () => {
    const parent = tmp('cat');
    try {
      rmSync(join(home, 'starters/cache'), { recursive: true, force: true });
      state.tamper = true;
      assert.equal(JSON.parse((await cli(['new', 'web', '--template', 'nextjs-app-router-fetch', '--yes', '--json'], parent)).out).error.code, 'checksum_mismatch');
      assert.ok(!existsSync(join(home, 'starters/cache/nextjs-app-router-fetch')));
      assert.deepEqual(readdirSync(parent), []);
    } finally {
      state.tamper = false;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('paid: not logged in → login (device code) → owned works, not owned is refused; tokens stay secret', async () => {
    const parent = tmp('paid');
    try {
      assert.equal(JSON.parse((await cli(['new', 'pro', '--template', 'nextjs-pro', '--yes', '--json'], parent)).out).error.code, 'not_logged_in');
      const login = await cli(['login', '--no-browser']);
      assert.equal(login.code, 0, login.err);
      assert.match(login.out, /enter code: WXYZ-1234/);
      assert.match(login.out, /Logged in as dev@example\.com/);
      const authFile = join(home, 'auth.json');
      if (process.platform !== 'win32') assert.equal(statSync(authFile).mode & 0o777, 0o600);
      const who = await cli(['whoami']);
      assert.match(who.out, /dev@example\.com\n {2}nextjs-pro {2}\(updates until 2027-10-24\)/);
      const r = await cli(['new', 'pro', '--template', 'nextjs-pro', '--no-steps', '--yes'], parent);
      assert.equal(r.code, 0, r.err);
      assert.equal(JSON.parse((await cli(['new', 'team', '--template', 'nextjs-team', '--yes', '--json'], parent)).out).error.code, 'no_entitlement');
      const leaks = [r.out, r.err, login.out, who.out, readFileSync(join(parent, 'pro/.codz/history.json'), 'utf8'), readFileSync(join(home, 'starters/runs.json'), 'utf8')].join('\n');
      assert.doesNotMatch(leaks, /secret|sig=ok/);
      const out = await cli(['logout']);
      assert.match(out.out, /Logged out/);
      assert.deepEqual(state.revokedTokens, ['refresh-secret-1']);
      assert.ok(!existsSync(authFile));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('a revoked version is refused, even from the cache', async () => {
    const parent = tmp('rev');
    try {
      writeFileSync(join(reg, 'catalog.json'), JSON.stringify({ templates: [{ id: 'nextjs-app-router-fetch', tier: 'free' }, { id: 'nextjs-pro', tier: 'paid' }, { id: 'nextjs-team', tier: 'paid' }], revoked: [{ id: 'nextjs-app-router-fetch', version: '1.0.0', reason: 'a security problem' }] }));
      buildIndex(reg, [keys.privatePem]);
      const r = JSON.parse((await cli(['new', 'web', '--template', 'nextjs-app-router-fetch', '--yes', '--json'], parent)).out);
      assert.equal(r.error.code, 'template_revoked');
      assert.match(r.error.message, /a security problem/);
      assert.equal(JSON.parse((await cli(['new', 'web', '--template', 'nextjs-app-router-fetch', '--cached', '--yes', '--json'], parent)).out).error.code, 'template_revoked');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('an older index (rollback) and a bad signature are refused; an expired index is refused online', async () => {
    state.serveOld = oldIndex;
    try {
      assert.equal(JSON.parse((await cli(['starters', 'list', '--refresh', '--json'])).out).error.code, 'index_rollback');
    } finally {
      state.serveOld = null;
    }
    const other = generateKeys();
    const good = readFileSync(join(reg, 'v1/index.json'));
    buildIndex(reg, [other.privatePem]);
    assert.equal(JSON.parse((await cli(['starters', 'list', '--refresh', '--json'])).out).error.code, 'signature_invalid');
    buildIndex(reg, [keys.privatePem], { days: -1 });
    assert.equal(JSON.parse((await cli(['starters', 'list', '--refresh', '--json'])).out).error.code, 'index_expired');
    // Offline, the last good index still works, with a note about its age.
    const cached = await cli(['starters', 'list', '--cached']);
    assert.equal(cached.code, 0, cached.err);
    void good;
    buildIndex(reg, [keys.privatePem]); // a good, current index again for the next tests
  });

  it('from an agent (MCP): a paid starter that is not downloaded needs the user; login is not a tool; new only plans', async () => {
    const parent = tmp('mcp');
    process.env.CODZ_MCP = '1';
    try {
      const r = JSON.parse((await cli(['new', 'team', '--template', 'nextjs-team', '--json'], parent)).out);
      assert.equal(r.error.code, 'needs_approval');
      const { mcpTools, cliArgs } = await import('../src/skills/mcp.ts');
      const tools = mcpTools();
      assert.ok(!tools.some((t) => t.name === 'login' || t.name === 'logout'));
      const tool = tools.find((t) => t.name === 'new')!;
      assert.ok(cliArgs(tool, { args: ['web'], template: 'nextjs-app-router-fetch' }).includes('--plan'));
    } finally {
      delete process.env.CODZ_MCP;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('two-key catalogs: an online key confirms freshness; expired, mismatched, missing and replayed notes are refused', async () => {
    const online = generateKeys();
    const list = async () => JSON.parse((await cli(['starters', 'list', '--refresh', '--json'])).out);
    try {
      buildIndex(reg, [keys.privatePem], { days: 180, timestampKeys: [online.publicRaw] });
      rmSync(join(reg, 'v1/timestamp.json'), { force: true });
      assert.equal((await list()).error.code, 'index_expired', 'no freshness note');
      signTimestamp(reg, online.privatePem, { hours: 48 });
      assert.equal((await list()).ok, true);
      assert.ok(existsSync(join(home, 'starters/timestamp.json')));
      // A note signed by a key the index does not list.
      signTimestamp(reg, keys.privatePem, { hours: 48 });
      assert.equal((await list()).error.code, 'signature_invalid');
      // Expired.
      signTimestamp(reg, online.privatePem, { hours: -1 });
      assert.equal((await list()).error.code, 'index_expired');
      // An older note than one already seen, for the same index.
      signTimestamp(reg, online.privatePem, { hours: 48, now: new Date(Date.now() - 3_600_000) });
      assert.equal((await list()).error.code, 'index_rollback');
      // A note for a different index (published again without a new note).
      signTimestamp(reg, online.privatePem, { hours: 48 });
      assert.equal((await list()).ok, true);
      buildIndex(reg, [keys.privatePem], { days: 180, timestampKeys: [online.publicRaw] });
      assert.equal((await list()).error.code, 'index_expired');
      signTimestamp(reg, online.privatePem, { hours: 48 });
      assert.equal((await list()).ok, true);
      // Offline: the stored note is checked too, and only warns.
      const cached = await cli(['starters', 'list', '--cached']);
      assert.equal(cached.code, 0);
      assert.doesNotMatch(cached.err, /no longer confirmed/);
    } finally {
      buildIndex(reg, [keys.privatePem]);
      rmSync(join(reg, 'v1/timestamp.json'), { force: true });
      rmSync(join(reg, 'v1/timestamp.json.sig'), { force: true });
    }
  });

  it('starters cache lists and clears downloads', async () => {
    assert.match((await cli(['starters', 'cache'])).out, /nextjs-pro 1\.0\.0/);
    assert.match((await cli(['starters', 'cache', '--clear'])).out, /Removed \d+ downloaded starter/);
    assert.ok(!existsSync(join(home, 'starters/cache')));
  });
});

describe('starters: isolation', () => {
  it('no core, adapter or skill file imports the starters module; the CLI loads it only on demand', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
    for (const f of walk(join(REPO, 'src')).filter((f) => !f.includes(`${join('src', 'starters')}`))) {
      const t = readFileSync(f, 'utf8');
      const staticImports = [...t.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1]);
      assert.ok(!staticImports.some((p) => p.includes('starters/')), `${f} imports the starters module`);
      if (!f.endsWith('cli.ts')) assert.ok(!/import\(\s*'[^']*starters\//.test(t), `${f} loads the starters module`);
    }
    // Nothing outside src/starters calls fetch or opens sockets.
    for (const f of walk(join(REPO, 'src')).filter((f) => !f.includes(`${join('src', 'starters')}`))) {
      const t = readFileSync(f, 'utf8');
      assert.ok(!/\bfetch\(\s*[`'"]https?:|node:https?'|node:net'|from 'undici'/.test(t), `${f} has network code`);
    }
  });
});
