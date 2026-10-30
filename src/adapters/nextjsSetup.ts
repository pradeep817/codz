// Next.js `setup`: creates an API layer for a project that has none yet.
//   fetch-helper  lib/api/client.ts with apiFetch<T>() and ApiError (recommended)
//   plain-fetch   each generated function calls fetch itself
// Both store the base URL in NEXT_PUBLIC_API_URL (.env.example and .env.local).

import { jsString } from '../core/safe.ts';
import { join } from 'node:path';
import { detectEol, readText, withEol } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type ArchitectureOption, type Conventions, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';

const ENV = 'NEXT_PUBLIC_API_URL';

export function nextArchitectures(map: ProjectMap): ArchitectureOption[] {
  const c = map.conventions;
  if (map.endpoints.length > 0 || (c.httpHelper && c.httpHelper !== 'fetch') || c.http === 'axios') return [];
  return [
    { id: 'fetch-helper', label: 'Fetch helper', description: 'lib/api/client.ts with apiFetch<T>() and ApiError; one API file per resource; interfaces in types/', recommended: true },
    { id: 'plain-fetch', label: 'Plain fetch', description: 'Each API function calls fetch directly; no shared helper', recommended: false },
  ];
}

function clientFile(q: string, semi: string, baseUrl: string): string {
  return [
    `// ${ENV} comes from .env.local; the fallback is the URL setup was given.`,
    `const BASE_URL = process.env.${ENV} ?? ${jsString(baseUrl, q)}${semi}`,
    '',
    '/** Thrown when the API answers with a status outside 200-299. */',
    'export class ApiError extends Error {',
    `  status: number${semi}`,
    '',
    '  constructor(status: number, message: string) {',
    `    super(message)${semi}`,
    `    this.status = status${semi}`,
    '  }',
    '}',
    '',
    '/** Calls the API and parses the JSON response. Add auth headers here. */',
    'export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {',
    '  const res = await fetch(`${BASE_URL}${path}`, {',
    '    ...init,',
    `    headers: { ${q}Content-Type${q}: ${q}application/json${q}, ...init.headers },`,
    `  })${semi}`,
    `  if (!res.ok) throw new ApiError(res.status, await res.text())${semi}`,
    `  if (res.status === 204) return undefined as T${semi}`,
    `  return (await res.json()) as T${semi}`,
    '}',
    '',
  ].join('\n');
}

/** Sets NAME=value in an env file, keeping everything else. */
function setEnv(text: string | null, value: string): string {
  if (text === null) return `${ENV}=${value}\n`;
  const eol = detectEol(text);
  const re = new RegExp(`^${ENV}=.*$`, 'm');
  if (re.test(text)) return text;
  return withEol(`${text.replace(/\s*$/, '')}${text.trim() ? '\n' : ''}${ENV}=${value}\n`, eol);
}

export function planNextSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  if (!['fetch-helper', 'plain-fetch'].includes(choice.architecture)) {
    throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose fetch-helper or plain-fetch.`);
  }
  const c = map.conventions;
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const read = (p: string) => readText(join(root, p));
  const src = (c.appDir ?? '').startsWith('src/') ? 'src/' : '';
  const apiFolder = `${src}lib/api`;
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  const baseUrl = choice.baseUrl || 'https://api.example.com';
  if (!choice.baseUrl) warnings.push(`No base URL was given, so ${ENV} is set to https://api.example.com. Change it in .env.example (and your .env.local).`);

  const conventions: Conventions = {
    ...c,
    http: 'fetch',
    apiFolder,
    apiFileNaming: 'kebab',
    apiFileSuffix: '',
    apiFileResource: 'plural',
    baseUrlEnv: ENV,
    modelsFolder: `${src}types`,
    modelsLayout: 'per-file',
    modelsFile: '',
    modelFileNaming: 'kebab',
    importStyle: c.importAlias ? 'alias' : 'relative',
    httpHelper: 'fetch',
    httpHelperFile: '',
  };

  if (choice.architecture === 'fetch-helper') {
    const client = `${apiFolder}/client.ts`;
    const index = `${apiFolder}/index.ts`;
    for (const p of [client, index]) {
      if (read(p) !== null) throw new ToolError('file_exists', `${p} already exists, so setup stopped without changing anything.`, 'Remove or rename it, or run devtool init again to use it as it is.');
    }
    files.set(client, clientFile(q, semi, baseUrl));
    summary.push(`Create ${client}: apiFetch<T>() and ApiError, reading the base URL from ${ENV}`);
    files.set(index, `export * from ${q}./client${q}${semi}\n`);
    summary.push(`Create ${index}: exports every API file`);
    conventions.httpHelper = 'apiFetch';
    conventions.httpHelperFile = client;
  }

  // .env.example only: .env.local is the developer's own file and may hold secrets, so devtool never writes it.
  {
    const envFile = '.env.example';
    const before = read(envFile);
    const after = setEnv(before, baseUrl);
    if (after !== before) {
      files.set(envFile, after);
      summary.push(`${before === null ? 'Create' : 'Update'} ${envFile}: ${ENV}=${baseUrl}`);
    }
    const local = read('.env.local');
    if (local === null || !new RegExp(`^${ENV}=`, 'm').test(local)) summary.push(`Copy ${ENV} from .env.example into .env.local (devtool does not write .env.local)${choice.architecture === 'fetch-helper' ? `; until then lib/api/client.ts falls back to ${baseUrl}` : ': the API functions read it'}`);
  }
  summary.push(`Save conventions: API files in ${apiFolder}, interfaces in ${conventions.modelsFolder}`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged: false };
}
