// test add for Android: JUnit tests for Retrofit interfaces against OkHttp's
// MockWebServer, so they run on the JVM without a device or network.
//
// One test class per API interface (app/src/test/java/<package>/<Api>Test.kt).
// Each test enqueues example JSON built from the models, calls the method, and
// checks the request method and path and that the body parsed. A second test
// per interface checks that an HTTP 500 throws retrofit2.HttpException.
// testImplementation dependencies (mockwebserver, coroutines-test, junit) are
// added to the version catalog or build.gradle.kts when missing.

import { join } from 'node:path';
import { packageOf } from '../adapters/android.ts';
import { gradleBlockAdd, tomlAdd } from '../adapters/androidSetup.ts';
import { addKotlinImports, kotlinName } from '../adapters/kotlinGen.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { readText } from '../core/fsutil.ts';
import { type ChangeSet, type EndpointInfo, type ProjectMap } from '../core/types.ts';
import { kotlinFun } from './androidUi.ts';
import { exampleFor } from './mock.ts';

const TEST_LIBS = [
  { key: 'okhttp-mockwebserver', group: 'com.squareup.okhttp3', name: 'mockwebserver', version: 'okhttp', value: '4.12.0' },
  { key: 'kotlinx-coroutines-test', group: 'org.jetbrains.kotlinx', name: 'kotlinx-coroutines-test', version: 'coroutines', value: '1.9.0' },
  { key: 'junit', group: 'junit', name: 'junit', version: 'junit', value: '4.13.2' },
];

const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/'));

/** A Kotlin expression for an example value of a type (models become constructor calls). */
function kotlinValue(type: string, value: unknown, map: ProjectMap, indent: string): string {
  const t = type.replace(/\?$/, '').trim();
  if (value === null || value === undefined) return type.endsWith('?') ? 'null' : t === 'String' ? '""' : t === 'Boolean' ? 'false' : /^(Int|Long|Double|Float)$/.test(t) ? '0' : 'TODO()';
  const list = /^List<(.+)>$/.exec(t);
  if (list) return Array.isArray(value) && value.length ? `listOf(${value.map((v) => kotlinValue(list[1], v, map, indent)).join(', ')})` : 'emptyList()';
  const model = map.models.find((m) => m.name === t);
  if (model && typeof value === 'object') {
    const inner = `${indent}    `;
    const args = model.fields.map((f) => `${inner}${kotlinName(f.name)} = ${kotlinValue(f.type + (f.nullable ? '?' : ''), (value as Record<string, unknown>)[f.name], map, inner)},`);
    return `${t}(\n${args.join('\n')}\n${indent})`;
  }
  if (t === 'String') return JSON.stringify(String(value)).replace(/\$/g, '\\$');
  if (t === 'Long') return `${Math.trunc(Number(value))}L`;
  if (t === 'Double') return Number.isInteger(value) ? `${value}.0` : String(value);
  if (t === 'Float') return `${value}f`;
  return String(value);
}

function converter(ser: string): { expr: string; imports: string[] } {
  if (ser === 'moshi') return { expr: 'MoshiConverterFactory.create(Moshi.Builder().build())', imports: ['com.squareup.moshi.Moshi', 'retrofit2.converter.moshi.MoshiConverterFactory'] };
  if (ser === 'gson') return { expr: 'GsonConverterFactory.create()', imports: ['retrofit2.converter.gson.GsonConverterFactory'] };
  return { expr: 'Json { ignoreUnknownKeys = true }.asConverterFactory("application/json".toMediaType())', imports: ['kotlinx.serialization.json.Json', 'okhttp3.MediaType.Companion.toMediaType', 'retrofit2.converter.kotlinx.serialization.asConverterFactory'] };
}

export function androidTests(root: string, map: ProjectMap, eps: EndpointInfo[]): ChangeSet {
  const c = map.conventions;
  const srcDir = c.srcDir || 'app/src/main/java';
  const testDir = srcDir.replace(/\/main\//, '/test/');
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const conv = converter(c.serialization || 'kotlinx');

  const byFile = new Map<string, EndpointInfo[]>();
  for (const ep of eps) byFile.set(ep.file, [...(byFile.get(ep.file) ?? []), ep]);
  for (const [apiFile, list] of byFile) {
    const apiText = read(apiFile) ?? '';
    const iface = /\binterface\s+(\w+)/.exec(apiText)?.[1];
    if (!iface) {
      warnings.push(`No interface found in ${apiFile}; skipped ${list.map((e) => e.name).join(', ')}.`);
      continue;
    }
    const pkg = packageOf(srcDir, dirOf(apiFile));
    const testFile = `${testDir}/${pkg.replace(/\./g, '/')}/${iface}Test.kt`;
    const existing = read(testFile);
    const tests: string[] = [];
    const imports = new Set<string>();
    for (const ep of list) {
      if (existing && new RegExp(`fun\\s+\`?${ep.name}\\b`).test(existing)) {
        summary.push(`${ep.name} already has a test in ${testFile}; skipped`);
        continue;
      }
      const fun = kotlinFun(apiText, ep.name);
      if (!fun) {
        warnings.push(`Could not read ${ep.name} in ${apiFile}; skipped.`);
        continue;
      }
      const values = new Map<string, string>();
      const args: string[] = [];
      for (const p of fun.params) {
        const name = p.name.replace(/`/g, '');
        if (p.annotation === 'Body') {
          const bodyType = p.type.replace(/\?$/, '');
          const model = map.models.find((m) => m.name === bodyType);
          if (model) imports.add(`${packageOf(srcDir, dirOf(model.file))}.${model.name}`);
          args.push(`${p.name} = ${kotlinValue(p.type, exampleFor(bodyType, map, name), map, '            ')}`);
        } else if (p.annotation === 'Path') {
          const v = /^(Int|Long)$/.test(p.type) ? '1' : '"abc"';
          values.set(p.wire ?? name, v.replace(/"/g, ''));
          args.push(`${p.name} = ${v}`);
        } else if (!p.optional) args.push(`${p.name} = ${kotlinValue(p.type, exampleFor(p.type, map, name), map, '            ')}`);
      }
      const unit = fun.returnType === 'Unit';
      const body = unit ? '' : JSON.stringify(exampleFor(fun.returnType, map, ''));
      const rel = /@(?:GET|POST|PUT|PATCH|DELETE|HEAD)\(\s*"([^"]*)"/.exec(apiText.slice(fun.start, fun.end))?.[1] ?? ep.path.replace(/^\//, '');
      const reqPath = '/' + rel.replace(/^\//, '').replace(/\{([^}]+)\}/g, (_m, n: string) => values.get(n) ?? '1');
      const call = `api.${ep.name}(${args.length > 1 || args.some((a) => a.includes('\n')) ? `\n            ${args.join(',\n            ')},\n        ` : args.join('')})`;
      tests.push(
        [
          '    @Test',
          `    fun ${ep.name}() = runTest {`,
          `        server.enqueue(MockResponse().setResponseCode(200)${unit ? '' : `.setHeader("Content-Type", "application/json").setBody(${JSON.stringify(body).replace(/\$/g, '\\$')})`})`,
          '',
          unit ? `        ${call}` : `        val result = ${call}`,
          '',
          '        val request = server.takeRequest()',
          `        assertEquals("${ep.method}", request.method)`,
          `        assertEquals("${reqPath}", request.path?.substringBefore('?'))`,
          ...(unit ? [] : [Array.isArray(JSON.parse(body)) ? '        assertEquals(2, result.size)' : '        assertNotNull(result)']),
          '    }',
        ].join('\n'),
      );
      summary.push(`Test ${ep.name}(): ${ep.method} ${reqPath}${unit ? '' : ', parses the example body'}`);
    }
    if (!tests.length) continue;
    const first = list[0];
    const firstFun = kotlinFun(apiText, first.name);
    if (!existing && firstFun) {
      const args = firstFun.params.filter((p) => p.annotation === 'Path' || (p.annotation !== 'Body' && !p.optional)).map((p) => `${p.name} = ${/^(Int|Long)$/.test(p.type) ? '1' : '"abc"'}`);
      const hasBody = firstFun.params.find((p) => p.annotation === 'Body');
      if (!hasBody) {
        tests.push(
          [
            '    @Test',
            `    fun \`${first.name} throws HttpException on a server error\`() = runTest {`,
            '        server.enqueue(MockResponse().setResponseCode(500))',
            '',
            `        val error = runCatching { api.${first.name}(${args.join(', ')}) }.exceptionOrNull()`,
            '',
            '        assertTrue(error is HttpException)',
            '        assertEquals(500, (error as HttpException).code())',
            '    }',
          ].join('\n'),
        );
        imports.add('retrofit2.HttpException');
        imports.add('org.junit.Assert.assertTrue');
      }
    }
    const allImports = [...imports, ...conv.imports, `${pkg}.${iface}`, 'kotlinx.coroutines.test.runTest', 'okhttp3.mockwebserver.MockResponse', 'okhttp3.mockwebserver.MockWebServer', 'org.junit.After', 'org.junit.Assert.assertEquals', 'org.junit.Assert.assertNotNull', 'org.junit.Before', 'org.junit.Test', 'retrofit2.Retrofit'];
    let text: string;
    if (existing) {
      const close = existing.lastIndexOf('}');
      text = `${existing.slice(0, close).replace(/\s*$/, '\n')}\n${tests.join('\n\n')}\n}\n`;
    } else {
      text = [
        `package ${pkg}`,
        '',
        `class ${iface}Test {`,
        '    private val server = MockWebServer()',
        `    private lateinit var api: ${iface}`,
        '',
        '    @Before',
        '    fun setUp() {',
        '        server.start()',
        '        api = Retrofit.Builder()',
        '            .baseUrl(server.url("/"))',
        `            .addConverterFactory(${conv.expr})`,
        '            .build()',
        `            .create(${iface}::class.java)`,
        '    }',
        '',
        '    @After',
        '    fun tearDown() {',
        '        server.shutdown()',
        '    }',
        '',
        tests.join('\n\n'),
        '}',
        '',
      ].join('\n');
    }
    text = addKotlinImports(text, allImports, pkg);
    // assertNotNull only when used.
    if (!/assertNotNull\(/.test(text.replace(/^import .*$/gm, ''))) text = text.replace(/^import org\.junit\.Assert\.assertNotNull\n/m, '');
    files.set(testFile, text);
    summary.unshift(`${existing ? 'Update' : 'Create'} ${testFile}`);
  }

  // testImplementation dependencies.
  const module = c.module || 'app';
  const build = [`${module}/build.gradle.kts`].find((f) => read(f) !== null);
  const catalogPath = c.versionCatalog || '';
  const catalog = catalogPath ? read(catalogPath) : null;
  if (files.size && build) {
    let b = read(build)!;
    if (catalog !== null) {
      let t = tomlAdd(catalog, 'versions', TEST_LIBS.map((l) => [l.version, `"${l.value}"`]));
      t = tomlAdd(t, 'libraries', TEST_LIBS.map((l) => [l.key, `{ group = "${l.group}", name = "${l.name}", version.ref = "${l.version}" }`]));
      if (t !== catalog) {
        files.set(catalogPath, t);
        summary.push(`Update ${catalogPath}: test libraries`);
      }
      b = gradleBlockAdd(b, 'dependencies', TEST_LIBS.map((l) => `testImplementation(libs.${l.key.replace(/-/g, '.')})`));
    } else b = gradleBlockAdd(b, 'dependencies', TEST_LIBS.map((l) => `testImplementation("${l.group}:${l.name}:${l.value}")`));
    if (b !== read(build)) {
      files.set(build, b);
      summary.push(`Update ${build}: testImplementation MockWebServer, coroutines-test, JUnit`);
    }
  } else if (files.size) warnings.push(`Add testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0"), kotlinx-coroutines-test and JUnit to your app module.`);
  if (files.size) summary.push(`Run them with: ./gradlew :${module}:testDebugUnitTest`);
  return buildChangeSet(root, 'test add', { files, summary, warnings, generated: [] });
}
