// Deterministic naming helpers shared by skills and adapters.

export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);

export const pascal = (s: string) => words(s).map(cap).join('');
export const camel = (s: string) => {
  const p = pascal(s);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
};
export const snake = (s: string) => words(s).join('_');
export const kebab = (s: string) => words(s).join('-');

export type FileNaming = 'kebab' | 'camel' | 'pascal' | 'snake';

export function fileName(base: string, style: FileNaming): string {
  switch (style) {
    case 'camel':
      return camel(base);
    case 'pascal':
      return pascal(base);
    case 'snake':
      return snake(base);
    default:
      return kebab(base);
  }
}

/** Guesses the naming style of a set of file base names (without extension). */
export function detectFileNaming(names: string[], fallback: FileNaming): FileNaming {
  const counts: Record<FileNaming, number> = { kebab: 0, camel: 0, pascal: 0, snake: 0 };
  for (const n of names) {
    if (n.includes('-')) counts.kebab++;
    else if (n.includes('_')) counts.snake++;
    else if (/^[A-Z]/.test(n) && /[a-z]/.test(n)) counts.pascal++;
    else if (/^[a-z]+[A-Z]/.test(n)) counts.camel++;
  }
  let best: FileNaming = fallback;
  let bestCount = 0;
  for (const style of ['kebab', 'camel', 'pascal', 'snake'] as FileNaming[]) {
    if (counts[style] > bestCount) {
      best = style;
      bestCount = counts[style];
    }
  }
  return best;
}

const IRREGULAR: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  data: 'data',
  news: 'news',
  status: 'status',
  series: 'series',
  species: 'species',
  analytics: 'analytics',
  settings: 'settings',
  me: 'me',
};

/** Singularizes the last word of an identifier, keeping its case style. */
export function singular(word: string): string {
  const lower = word.toLowerCase();
  if (IRREGULAR[lower]) return matchCase(word, IRREGULAR[lower]);
  if (/ies$/i.test(word) && word.length > 4) return word.slice(0, -3) + matchCase(word.slice(-3), 'y');
  if (/(ss|us|is)$/i.test(word)) return word;
  if (/(ss|x|ch|sh|z|us)es$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 2) return word.slice(0, -1);
  return word;
}

export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
}

function matchCase(source: string, target: string): string {
  if (source === source.toUpperCase()) return target.toUpperCase();
  if (source[0] === source[0].toUpperCase()) return cap(target);
  return target;
}

/** Makes a safe identifier from any string (used for JSON keys that are not valid identifiers). */
export function identifier(jsonKey: string, reserved: Set<string>): string {
  let id = camel(jsonKey);
  if (!id) id = 'field';
  if (/^[0-9]/.test(id)) id = `n${id}`;
  if (reserved.has(id)) id = `${id}Value`;
  return id;
}

export const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
]);

export const DART_RESERVED = new Set([
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'covariant',
  'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export', 'extends', 'extension', 'external', 'factory', 'false',
  'final', 'finally', 'for', 'Function', 'get', 'hide', 'if', 'implements', 'import', 'in', 'interface', 'is', 'late',
  'library', 'mixin', 'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow', 'return', 'set', 'show', 'static',
  'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var', 'void', 'while', 'with', 'yield', 'hashCode',
  'runtimeType', 'toString', 'noSuchMethod',
]);

/**
 * A function name that compiles in both TypeScript and Dart. Names from an
 * operationId, a Postman item or --name can be reserved words ("delete") or
 * start with a digit ("2fa.verify"). A reserved word falls back to the name
 * derived from the path (deleteUser); a leading digit gets the method in front.
 */
export function functionName(raw: string, method: string, fallback?: string): string {
  let name = camel(raw);
  if (!name) name = fallback ?? camel(`${method} request`);
  if (/^[0-9]/.test(name)) name = `${method.toLowerCase()}${name}`;
  if (TS_RESERVED.has(name) || DART_RESERVED.has(name)) {
    name = fallback && fallback !== name && !TS_RESERVED.has(fallback) && !DART_RESERVED.has(fallback) ? fallback : `${name}Request`;
  }
  return name;
}

/** A class or interface name that compiles in both languages. */
export function typeName(raw: string, fallback = 'Item'): string {
  let name = pascal(raw) || fallback;
  if (/^[0-9]/.test(name)) name = `${fallback === 'Item' ? 'Model' : fallback}${name}`;
  if (TS_RESERVED.has(name) || DART_RESERVED.has(name)) name = `${name}Model`;
  return name;
}
