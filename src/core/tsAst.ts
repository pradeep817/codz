// TypeScript syntax trees for exact rename/remove/usage analysis, using the TypeScript compiler the
// project already has (node_modules/typescript). codz itself has no runtime
// dependencies, so when the project has no TypeScript (or CODZ_NO_AST=1),
// callers fall back to the text scanner.

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { exists } from './fsutil.ts';

// The parts of the TypeScript API used here, typed loosely so codz needs no @types.
// deno-lint-ignore no-explicit-any
type TS = any;
// deno-lint-ignore no-explicit-any
type Node = any;

const cache = new Map<string, TS | null>();

/** The project's TypeScript module, or codz's own in development, or null. */
export function loadTypeScript(root: string): TS | null {
  if (process.env.CODZ_NO_AST === '1') return null;
  if (cache.has(root)) return cache.get(root)!;
  let ts: TS | null = null;
  for (const base of [join(root, 'package.json'), import.meta.url]) {
    try {
      if (base.endsWith('package.json') && !exists(join(root, 'node_modules', 'typescript'))) continue;
      const mod = createRequire(base)('typescript');
      if (mod?.createSourceFile) {
        ts = mod;
        break;
      }
    } catch {
      // Not installed there.
    }
  }
  cache.set(root, ts);
  return ts;
}

function parse(ts: TS, file: string, text: string): Node {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx?$|\.mjs$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

export interface TsUse {
  index: number;
  line: number;
  kind: 'call' | 'import' | 'export' | 'reference';
}

/**
 * Every place an identifier refers to the module-level binding `name`: calls,
 * references, import and export specifiers, and `ns.name` through a namespace
 * import. Skips property names on other objects, object keys, strings,
 * comments, and code where a local variable or parameter shadows the name.
 */
export function tsIdentifierUses(ts: TS, file: string, text: string, name: string, opts: { declStart?: number } = {}): TsUse[] {
  const sf = parse(ts, file, text);
  const namespaces = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamespaceImport(st.importClause.namedBindings)) namespaces.add(st.importClause.namedBindings.name.text);
  }
  const out: TsUse[] = [];
  // Does this function or block declare its own `name` (a parameter, or a
  // variable, function or class directly inside it)? Nested blocks and
  // functions are their own scopes and are checked when the walk gets there.
  const declares = (node: Node): boolean => {
    const items: Node[] = [];
    if (ts.isFunctionLike(node)) {
      items.push(...(node.parameters ?? []));
      if (node.body && ts.isBlock(node.body)) items.push(...node.body.statements);
    } else if (ts.isBlock(node)) items.push(...node.statements);
    let found = false;
    const visit = (n: Node) => {
      if (found) return;
      if ((ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name) found = true;
      else if (ts.isBlock(n) || ts.isFunctionLike(n) || ts.isClassLike(n)) {
        if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name) found = true;
        return;
      } else ts.forEachChild(n, visit);
    };
    items.forEach(visit);
    return found;
  };
  const walk = (n: Node, shadowed: boolean) => {
    const scopeShadows = !shadowed && (ts.isFunctionLike(n) || ts.isBlock(n)) && n !== sf && declares(n);
    const sh = shadowed || scopeShadows;
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      const at = n.getStart(sf);
      const line = sf.getLineAndCharacterOfPosition(at).line + 1;
      if (opts.declStart !== undefined && at === opts.declStart) return;
      if (ts.isImportSpecifier(p) || ts.isImportClause(p)) out.push({ index: at, line, kind: 'import' });
      else if (ts.isExportSpecifier(p)) out.push({ index: at, line, kind: 'export' });
      else if (ts.isPropertyAccessExpression(p) && p.name === n) {
        if (ts.isIdentifier(p.expression) && namespaces.has(p.expression.text) && !sh) out.push({ index: at, line, kind: ts.isCallExpression(p.parent) ? 'call' : 'reference' });
      } else if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isMethodSignature(p)) && p.name === n) {
        // An object key or class member with the same name: not a use.
      } else if (ts.isShorthandPropertyAssignment(p) && !sh) out.push({ index: at, line, kind: 'reference' });
      else if ((ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === n) {
        // A declaration (the endpoint itself, or a local that shadows it).
      } else if (!sh) out.push({ index: at, line, kind: ts.isCallExpression(p) && p.expression === n ? 'call' : 'reference' });
    }
    ts.forEachChild(n, (c: Node) => walk(c, sh));
  };
  walk(sf, false);
  return out;
}
