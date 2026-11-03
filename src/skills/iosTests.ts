// test add for iOS: XCTest cases for the APIClient methods, answered by a
// URLProtocol stub, so they run in the simulator without a server.
//
// One test class per APIClient extension file (<App>Tests/<Resource>APITests.swift),
// sharing StubURLProtocol.swift. Each test sets an example JSON answer built
// from the models, calls the method, and checks the request's method and path
// and the decoded result; a second test checks that a 500 throws APIError.
//
// Projects without a unit-test target get one (<App>Tests, a synchronized
// folder, hosted by the app) when the Xcode project uses synchronized folders
// (Xcode 16); older projects are asked to add the target in Xcode first.

import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
import { swiftName, xcodeProject } from '../adapters/ios.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type ChangeSet, type EndpointInfo, type ProjectMap } from '../core/types.ts';
import { pascal } from '../input/naming.ts';
import { swiftMethod } from './iosUi.ts';
import { exampleFor } from './mock.ts';

// ---------- the test target ----------

interface TargetInfo {
  /** The folder the tests go in, relative to the project root. */
  folder: string;
  /** The module to @testable import. */
  module: string;
}

/** The unit-test target's folder, or null when the project has none. */
function findTestTarget(pbx: string): string | null {
  // One native target block at a time (they end with a tab-indented "};").
  for (const m of pbx.matchAll(/\w{24} \/\* [^*]+ \*\/ = \{\s*isa = PBXNativeTarget;[^]*?\n\t\t\};/g)) {
    const block = m[0];
    if (!/productType = "com\.apple\.product-type\.bundle\.unit-test";/.test(block)) continue;
    const groups = /fileSystemSynchronizedGroups = \(\s*(\w{24})/.exec(block);
    if (groups) {
      const path = new RegExp(`${groups[1]} /\\* [^*]* \\*/ = \\{\\s*isa = PBXFileSystemSynchronizedRootGroup;[^}]*?path = "?([^";]+)"?;`).exec(pbx)?.[1];
      if (path) return path;
    }
    const name = /name = "?([^";]+)"?;/.exec(block)?.[1];
    if (name) return name;
  }
  return null;
}

/**
 * Adds a unit-test target hosted by the app to a project that uses synchronized
 * folders: the .xctest product, the <App>Tests folder group, the target with its
 * build phases and settings, and the dependency on the app.
 */
export function addIosTestTarget(pbx: string, app: string, bundleId: string): string {
  if (!/PBXFileSystemSynchronizedRootGroup/.test(pbx)) throw new ToolError('not_supported', 'This Xcode project has no unit-test target, and codz adds one only to projects that use synchronized folders (Xcode 16).', `In Xcode: File → New → Target → Unit Testing Bundle, name it ${app}Tests, then run codz test add again.`);
  const appTarget = [...pbx.matchAll(/(\w{24}) \/\* ([^*]+) \*\/ = \{\s*isa = PBXNativeTarget;[^]*?\n\t\t\};/g)].find((b) => /productType = "com\.apple\.product-type\.application";/.test(b[0]));
  if (!appTarget) throw new ToolError('not_supported', 'No app target was found in the Xcode project.');
  const appId = appTarget[1];
  const appName = appTarget[2].trim();
  const project = /rootObject = (\w{24})/.exec(pbx)?.[1];
  const productsGroup = /productRefGroup = (\w{24})/.exec(pbx)?.[1];
  const mainGroup = /mainGroup = (\w{24})/.exec(pbx)?.[1];
  if (!project || !productsGroup || !mainGroup) throw new ToolError('not_supported', 'The Xcode project file is not laid out the way codz expects, so it has no unit-test target codz can add.', `In Xcode: File → New → Target → Unit Testing Bundle, name it ${app}Tests, then run codz test add again.`);
  const name = `${app}Tests`;
  const used = new Set(pbx.match(/\b[0-9A-F]{24}\b/g) ?? []);
  let n = 0;
  const id = () => {
    for (;;) {
      const h = createHash('sha1').update(`${name}:${n++}`).digest('hex').slice(0, 20).toUpperCase();
      const v = `C0DE${h}`;
      if (!used.has(v)) return used.add(v), v;
    }
  };
  const [product, group, target, sources, frameworks, resources, proxy, dependency, list, debug, release] = Array.from({ length: 11 }, id);
  const settings = (cfg: 'Debug' | 'Release', key: string) => [
    `\t\t${key} /* ${cfg} */ = {`,
    '\t\t\tisa = XCBuildConfiguration;',
    '\t\t\tbuildSettings = {',
    '\t\t\t\tBUNDLE_LOADER = "$(TEST_HOST)";',
    '\t\t\t\tCODE_SIGN_STYLE = Automatic;',
    '\t\t\t\tCURRENT_PROJECT_VERSION = 1;',
    '\t\t\t\tGENERATE_INFOPLIST_FILE = YES;',
    '\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;',
    '\t\t\t\tMARKETING_VERSION = 1.0;',
    `\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleId}.tests;`,
    '\t\t\t\tPRODUCT_NAME = "$(TARGET_NAME)";',
    '\t\t\t\tSWIFT_EMIT_LOC_STRINGS = NO;',
    '\t\t\t\tSWIFT_VERSION = 5.0;',
    '\t\t\t\tTARGETED_DEVICE_FAMILY = "1,2";',
    `\t\t\t\tTEST_HOST = "$(BUILT_PRODUCTS_DIR)/${appName}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${appName}";`,
    '\t\t\t};',
    `\t\t\tname = ${cfg};`,
    '\t\t};',
  ];
  const phase = (key: string, isa: string, label: string) => [`\t\t${key} /* ${label} */ = {`, `\t\t\tisa = ${isa};`, '\t\t\tbuildActionMask = 2147483647;', '\t\t\tfiles = (', '\t\t\t);', '\t\t\trunOnlyForDeploymentPostprocessing = 0;', '\t\t};'];
  const add = (text: string, section: string, lines: string[]) => {
    const end = `/* End ${section} section */`;
    if (text.includes(end)) return text.replace(end, `${lines.join('\n')}\n${end}`);
    return text.replace('/* Begin XCBuildConfiguration section */', `/* Begin ${section} section */\n${lines.join('\n')}\n${end}\n\n/* Begin XCBuildConfiguration section */`);
  };
  let t = pbx;
  t = add(t, 'PBXContainerItemProxy', [`\t\t${proxy} /* PBXContainerItemProxy */ = {`, '\t\t\tisa = PBXContainerItemProxy;', `\t\t\tcontainerPortal = ${project} /* Project object */;`, '\t\t\tproxyType = 1;', `\t\t\tremoteGlobalIDString = ${appId};`, `\t\t\tremoteInfo = ${appName};`, '\t\t};']);
  t = add(t, 'PBXFileReference', [`\t\t${product} /* ${name}.xctest */ = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = ${name}.xctest; sourceTree = BUILT_PRODUCTS_DIR; };`]);
  t = add(t, 'PBXFileSystemSynchronizedRootGroup', [`\t\t${group} /* ${name} */ = {`, '\t\t\tisa = PBXFileSystemSynchronizedRootGroup;', `\t\t\tpath = ${name};`, '\t\t\tsourceTree = "<group>";', '\t\t};']);
  t = add(t, 'PBXFrameworksBuildPhase', phase(frameworks, 'PBXFrameworksBuildPhase', 'Frameworks'));
  t = add(t, 'PBXNativeTarget', [
    `\t\t${target} /* ${name} */ = {`,
    '\t\t\tisa = PBXNativeTarget;',
    `\t\t\tbuildConfigurationList = ${list} /* Build configuration list for PBXNativeTarget "${name}" */;`,
    '\t\t\tbuildPhases = (',
    `\t\t\t\t${sources} /* Sources */,`,
    `\t\t\t\t${frameworks} /* Frameworks */,`,
    `\t\t\t\t${resources} /* Resources */,`,
    '\t\t\t);',
    '\t\t\tbuildRules = (',
    '\t\t\t);',
    '\t\t\tdependencies = (',
    `\t\t\t\t${dependency} /* PBXTargetDependency */,`,
    '\t\t\t);',
    '\t\t\tfileSystemSynchronizedGroups = (',
    `\t\t\t\t${group} /* ${name} */,`,
    '\t\t\t);',
    `\t\t\tname = ${name};`,
    '\t\t\tpackageProductDependencies = (',
    '\t\t\t);',
    `\t\t\tproductName = ${name};`,
    `\t\t\tproductReference = ${product} /* ${name}.xctest */;`,
    '\t\t\tproductType = "com.apple.product-type.bundle.unit-test";',
    '\t\t};',
  ]);
  t = add(t, 'PBXResourcesBuildPhase', phase(resources, 'PBXResourcesBuildPhase', 'Resources'));
  t = add(t, 'PBXSourcesBuildPhase', phase(sources, 'PBXSourcesBuildPhase', 'Sources'));
  t = add(t, 'PBXTargetDependency', [`\t\t${dependency} /* PBXTargetDependency */ = {`, '\t\t\tisa = PBXTargetDependency;', `\t\t\ttarget = ${appId} /* ${appName} */;`, `\t\t\ttargetProxy = ${proxy} /* PBXContainerItemProxy */;`, '\t\t};']);
  t = add(t, 'XCBuildConfiguration', [...settings('Debug', debug), ...settings('Release', release)]);
  t = add(t, 'XCConfigurationList', [
    `\t\t${list} /* Build configuration list for PBXNativeTarget "${name}" */ = {`,
    '\t\t\tisa = XCConfigurationList;',
    '\t\t\tbuildConfigurations = (',
    `\t\t\t\t${debug} /* Debug */,`,
    `\t\t\t\t${release} /* Release */,`,
    '\t\t\t);',
    '\t\t\tdefaultConfigurationIsVisible = 0;',
    '\t\t\tdefaultConfigurationName = Release;',
    '\t\t};',
  ]);
  // Children of the main and Products groups, the project's targets, and the target attributes.
  const addChild = (text: string, groupId: string, line: string) => text.replace(new RegExp(`(${groupId}(?: /\\* [^*]* \\*/)? = \\{\\s*isa = PBXGroup;\\s*children = \\()`), `$1\n\t\t\t\t${line},`);
  t = addChild(t, productsGroup, `${product} /* ${name}.xctest */`);
  t = addChild(t, mainGroup, `${group} /* ${name} */`);
  t = t.replace(/(isa = PBXProject;[^]*?targets = \()/, `$1\n\t\t\t\t${target} /* ${name} */,`);
  if (/TargetAttributes = \{/.test(t)) t = t.replace(/(TargetAttributes = \{)/, `$1\n\t\t\t\t\t${target} = {\n\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;\n\t\t\t\t\t\tTestTargetID = ${appId};\n\t\t\t\t\t};`);
  return t;
}

/** Makes sure there is a test target; returns where the tests go. */
function testTarget(root: string, map: ProjectMap, files: Map<string, string>, summary: string[]): TargetInfo {
  const proj = xcodeProject(root);
  if (!proj) throw new ToolError('not_supported', 'No .xcodeproj was found in this folder.');
  const pbxPath = `${proj}/project.pbxproj`;
  const pbx = readText(join(root, pbxPath)) ?? '';
  const app = proj.replace(/\.xcodeproj$/, '');
  const module = (/PRODUCT_NAME = ([A-Za-z_][\w]*);/.exec(pbx)?.[1] ?? app).replace(/\W/g, '_');
  const existing = findTestTarget(pbx);
  if (existing) return { folder: existing, module: module === 'TARGET_NAME' ? app : module };
  const bundle = /PRODUCT_BUNDLE_IDENTIFIER = ([\w.-]+);/.exec(pbx)?.[1] ?? `com.example.${app}`;
  files.set(pbxPath, addIosTestTarget(pbx, app, bundle));
  summary.push(`Update ${pbxPath}: a ${app}Tests unit-test target (hosted by the app, folder ${app}Tests)`);
  void map;
  return { folder: `${app}Tests`, module: app };
}

// ---------- the tests ----------

/** A Swift literal for an example value of a type: models become memberwise initializer calls. */
function swiftValue(type: string, value: unknown, map: ProjectMap): string {
  const optional = type.trim().endsWith('?');
  const t = type.replace(/\?$/, '').trim();
  if (value === null || value === undefined) return optional ? 'nil' : t === 'String' ? '""' : t === 'Bool' ? 'false' : /^(Int|Double|Float)$/.test(t) ? '0' : /^\[/.test(t) ? '[]' : 'nil';
  const list = /^\[(.+)\]$/.exec(t);
  if (list) return Array.isArray(value) ? `[${value.map((v) => swiftValue(list[1], v, map)).join(', ')}]` : '[]';
  const model = map.models.find((m) => m.name === t);
  if (model && typeof value === 'object') return `${t}(${model.fields.map((f) => `${swiftName(f.name).replace(/`/g, '')}: ${swiftValue(f.type + (f.nullable ? '?' : ''), (value as Record<string, unknown>)[f.name], map)}`).join(', ')})`;
  if (t === 'String') return JSON.stringify(String(value));
  if (t === 'Double' || t === 'Float') return Number.isInteger(value) ? `${value}.0` : String(value);
  return String(value);
}

/** A sample argument for a parameter: route-like values for ids, examples for bodies. */
function argValue(type: string, label: string, map: ProjectMap): { code: string; inPath: string } {
  const t = type.replace(/\?$/, '').trim();
  if (/^Int$/.test(t)) return { code: '1', inPath: '1' };
  if (/^Double$/.test(t)) return { code: '1.0', inPath: '1.0' };
  if (/^Bool$/.test(t)) return { code: 'true', inPath: 'true' };
  if (/^String$/.test(t)) return { code: '"1"', inPath: '1' };
  return { code: swiftValue(type, exampleFor(t, map, label), map), inPath: '' };
}

const STUB = (I: string) =>
  [
    'import Foundation',
    '',
    '/// Stands in for the network in tests: answers every request with `status` and `body`, and keeps the last request.',
    'final class StubURLProtocol: URLProtocol {',
    `${I}nonisolated(unsafe) static var status = 200`,
    `${I}nonisolated(unsafe) static var body = Data()`,
    `${I}nonisolated(unsafe) static var lastRequest: URLRequest?`,
    '',
    `${I}/// A session whose requests all go to this stub.`,
    `${I}static func session() -> URLSession {`,
    `${I}${I}let config = URLSessionConfiguration.ephemeral`,
    `${I}${I}config.protocolClasses = [StubURLProtocol.self]`,
    `${I}${I}return URLSession(configuration: config)`,
    `${I}}`,
    '',
    `${I}override class func canInit(with request: URLRequest) -> Bool { true }`,
    `${I}override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }`,
    '',
    `${I}override func startLoading() {`,
    `${I}${I}Self.lastRequest = request`,
    `${I}${I}let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!`,
    `${I}${I}client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)`,
    `${I}${I}client?.urlProtocol(self, didLoad: Self.body)`,
    `${I}${I}client?.urlProtocolDidFinishLoading(self)`,
    `${I}}`,
    '',
    `${I}override func stopLoading() {}`,
    '}',
    '',
  ].join('\n');

export function iosTests(root: string, map: ProjectMap, eps: EndpointInfo[]): ChangeSet {
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  if (!map.conventions.networkFile) throw new ToolError('not_supported', 'This project has no APIClient yet.', 'Run codz setup or codz feature add first.');
  const I = ' '.repeat(Number(map.conventions.indent) || 4);
  const target = testTarget(root, map, files, summary);
  const stubFile = `${target.folder}/StubURLProtocol.swift`;
  if (readText(join(root, stubFile)) === null) {
    files.set(stubFile, STUB(I));
    summary.push(`Create ${stubFile}: answers requests in tests without a server`);
  }
  const byFile = new Map<string, EndpointInfo[]>();
  for (const ep of eps) byFile.set(ep.file, [...(byFile.get(ep.file) ?? []), ep]);
  for (const [file, list] of byFile) {
    const source = readText(join(root, file)) ?? '';
    const resource = posix.basename(file, '.swift').replace(/^APIClient\+?/, '') || 'API';
    const cls = `${pascal(resource)}APITests`;
    const testFile = `${target.folder}/${cls}.swift`;
    const tests: string[] = [];
    for (const ep of list) {
      const sig = swiftMethod(source, ep.name);
      if (!sig) {
        warnings.push(`Could not read ${ep.name} in ${file}; no test for it.`);
        continue;
      }
      const args: string[] = [];
      let path = ep.path;
      for (const p of sig.params) {
        if (p.optional) continue;
        const v = argValue(p.type, p.label, map);
        args.push(`${p.label}: ${v.code}`);
        if (v.inPath) path = path.replace(`{${p.label}}`, v.inPath);
      }
      const call = `api.${ep.name}(${args.join(', ')})`;
      const ret = sig.returns;
      const isVoid = ret === 'Void' || ret === '()';
      const listMatch = /^\[(.+)\]$/.exec(ret);
      const sample = isVoid ? undefined : exampleFor(ret.replace(/^\[(.+)\]$/, '$1[]'), map, '');
      const body = isVoid ? '' : JSON.stringify(sample);
      const T = pascal(ep.name);
      tests.push(
        '',
        `${I}func test${T}() async throws {`,
        isVoid ? `${I}${I}StubURLProtocol.status = 204` : `${I}${I}StubURLProtocol.body = Data(#"${body}"#.utf8)`,
        isVoid ? `${I}${I}try await ${call}` : `${I}${I}let result = try await ${call}`,
        `${I}${I}XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "${ep.method}")`,
        ...(/^https?:/.test(path) ? [] : [`${I}${I}XCTAssertEqual(StubURLProtocol.lastRequest?.url?.path, "${path.split('?')[0]}")`]),
        ...(listMatch && Array.isArray(sample) ? [`${I}${I}XCTAssertEqual(result.count, ${sample.length})`] : isVoid ? [] : [`${I}${I}_ = result`]),
        `${I}}`,
        '',
        `${I}func test${T}ThrowsOnServerError() async {`,
        `${I}${I}StubURLProtocol.status = 500`,
        `${I}${I}StubURLProtocol.body = Data(#"{"error":"boom"}"#.utf8)`,
        `${I}${I}do {`,
        `${I}${I}${I}${isVoid ? 'try await' : '_ = try await'} ${call}`,
        `${I}${I}${I}XCTFail("Expected an error")`,
        `${I}${I}} catch let error as APIError {`,
        `${I}${I}${I}XCTAssertEqual(error.status, 500)`,
        `${I}${I}} catch {`,
        `${I}${I}${I}XCTFail("Unexpected error: \\(error)")`,
        `${I}${I}}`,
        `${I}}`,
      );
    }
    if (!tests.length) continue;
    const text = [
      'import XCTest',
      `@testable import ${target.module}`,
      '',
      `/// ${list.map((e) => e.name).join(', ')} against a stubbed network (codz test add).`,
      `final class ${cls}: XCTestCase {`,
      `${I}private var api: APIClient!`,
      '',
      `${I}override func setUp() {`,
      `${I}${I}super.setUp()`,
      `${I}${I}StubURLProtocol.status = 200`,
      `${I}${I}StubURLProtocol.body = Data()`,
      `${I}${I}StubURLProtocol.lastRequest = nil`,
      `${I}${I}api = APIClient(baseURL: URL(string: "https://api.test")!, session: StubURLProtocol.session())`,
      `${I}}`,
      ...tests,
      '}',
      '',
    ].join('\n');
    if (readText(join(root, testFile)) !== null) {
      warnings.push(`${testFile} already exists, so codz left it alone. Delete it to write it again.`);
      continue;
    }
    files.set(testFile, text);
    summary.push(`Create ${testFile}: ${list.length * 2} tests (${list.map((e) => e.name).join(', ')})`);
  }
  summary.push(`Run them: Product → Test (Cmd+U) in Xcode, or xcodebuild test -scheme ${target.module} -destination 'platform=iOS Simulator,name=iPhone 16'`);
  return buildChangeSet(root, 'test add', { files, summary, warnings, generated: [] });
}
