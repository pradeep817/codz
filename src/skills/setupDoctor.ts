// doctor --setup: can codz run here? Environment and configuration checks,
// separate from the project-health checks of plain `codz doctor`. Read-only.
//
// Every check returns pass, warn or fail with a message and, when useful, a hint.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { TOOL_DIR } from '../core/cache.ts';
import { CONFIG_FILE } from '../core/config.ts';
import { exists, readJson, readText, walk } from '../core/fsutil.ts';
import { dirtyFiles, isGitRepo } from '../core/git.ts';
import type { Adapter } from '../core/types.ts';
import { PATH_KEYS, validateConfig } from '../core/validateConfig.ts';
import { runTool } from '../core/proc.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

interface Ctx {
  root: string;
  adapter: Adapter;
  configText: string | null;
}

interface Check {
  id: string;
  run(ctx: Ctx): CheckResult | Omit<CheckResult, 'id'>;
}

// From source Node runs the TypeScript itself (22.18+); the npm build (dist/) needs 20+.
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const MIN_NODE = FROM_SOURCE ? [22, 18] : [20, 0];

const has = (cmd: string, args = ['--version']) => {
  const r = runTool(cmd, args, { timeout: 10000 });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
};

function pkgDeps(root: string): Record<string, string> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json'));
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

const pubspec = (root: string) => readText(join(root, 'pubspec.yaml')) ?? '';

export const CHECKS: Check[] = [
  {
    id: 'node_version',
    run() {
      const [maj, min] = process.versions.node.split('.').map(Number);
      const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
      return ok
        ? { status: 'pass', message: `v${process.versions.node}` }
        : { status: 'fail', message: `Node v${process.versions.node} is older than ${MIN_NODE.join('.')}.`, hint: FROM_SOURCE ? 'Run from source, codz needs Node 22.18 or newer (or run npm run build to use Node 20+). Install it with nvm, fnm or from nodejs.org.' : 'codz needs Node 20 or newer. Install it with nvm, fnm or from nodejs.org.' };
    },
  },
  {
    id: 'git_present',
    run({ root }) {
      if (!has('git')) return { status: 'warn', message: 'git is not installed.', hint: 'codz still works, but it cannot warn you about uncommitted changes before writing.' };
      return isGitRepo(root) ? { status: 'pass', message: 'git repository' } : { status: 'warn', message: 'This project is not a git repository.', hint: 'Run git init and commit, so every codz change is a reviewable diff.' };
    },
  },
  {
    id: 'git_clean',
    run({ root }) {
      if (!isGitRepo(root)) return { status: 'pass', message: 'not a git repository (skipped)' };
      const dirty = dirtyFiles(root).filter((f) => f !== CONFIG_FILE);
      return dirty.length
        ? { status: 'warn', message: `${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'} (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}).`, hint: 'Commands that write refuse a dirty tree unless you pass --allow-dirty.' }
        : { status: 'pass', message: 'working tree clean' };
    },
  },
  {
    id: 'config_found',
    run({ configText }) {
      return configText !== null ? { status: 'pass', message: CONFIG_FILE } : { status: 'fail', message: `No ${CONFIG_FILE} in this folder or above it.`, hint: 'Create it with: codz init' };
    },
  },
  {
    id: 'config_valid',
    run({ root, configText }) {
      if (configText === null) return { status: 'fail', message: 'no config to check', hint: 'codz init' };
      const issues = validateConfig(configText, root).filter((i) => !i.key || !PATH_KEYS.has(i.key));
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) return { status: 'fail', message: errors.map((e) => e.message).join(' '), hint: errors[0].hint ?? 'See every problem with: codz config check' };
      if (issues.length) return { status: 'warn', message: issues.map((e) => e.message).join(' '), hint: 'See every problem with: codz config check' };
      return { status: 'pass', message: 'parses; known keys and values' };
    },
  },
  {
    id: 'config_paths',
    run({ root, configText }) {
      if (configText === null) return { status: 'pass', message: 'no config (skipped)' };
      let issues;
      try {
        issues = validateConfig(configText, root).filter((i) => i.key && PATH_KEYS.has(i.key));
      } catch {
        return { status: 'pass', message: 'skipped' };
      }
      const errors = issues.filter((i) => i.level === 'error');
      if (errors.length) return { status: 'fail', message: errors.map((e) => e.message).join(' '), hint: errors[0].hint };
      if (issues.length) return { status: 'warn', message: issues.map((e) => e.message).join(' '), hint: issues[0].hint };
      return { status: 'pass', message: 'every path exists inside the project' };
    },
  },
  {
    id: 'gitignore',
    run({ root }) {
      if (isGitRepo(root)) {
        const r = spawnSync('git', ['check-ignore', '-q', `${TOOL_DIR}/cache/map.json`], { cwd: root });
        return r.status === 0 ? { status: 'pass', message: `${TOOL_DIR}/ is ignored` } : { status: 'warn', message: `${TOOL_DIR}/ is not in .gitignore.`, hint: `Add a line "${TOOL_DIR}/" to .gitignore; it holds the cache, backups and history.` };
      }
      const gi = readText(join(root, '.gitignore')) ?? '';
      return /^\/?\.codz\/?$/m.test(gi) ? { status: 'pass', message: `${TOOL_DIR}/ is ignored` } : { status: 'warn', message: `${TOOL_DIR}/ is not in .gitignore.`, hint: `Add a line "${TOOL_DIR}/" to .gitignore.` };
    },
  },
  {
    id: 'framework_supported',
    run({ adapter }) {
      return adapter.id === 'generic'
        ? { status: 'warn', message: 'No Next.js or Flutter project was found, so only explain and doctor work.', hint: 'Run codz from the folder with package.json (Next.js) or pubspec.yaml (Flutter).' }
        : { status: 'pass', message: `${adapter.id}@${adapter.version}` };
    },
  },
  {
    id: 'unsupported_libs',
    run({ root, adapter }) {
      const found: string[] = [];
      if (adapter.id === 'nextjs') {
        if (!exists(join(root, 'app')) && !exists(join(root, 'src/app')) && (exists(join(root, 'pages')) || exists(join(root, 'src/pages')))) found.push('Pages Router (api add and mocks expect the App Router; route add works)');
        if (pkgDeps(root).swr) found.push('SWR (hooks are written for TanStack Query only)');
      } else if (adapter.id === 'flutter') {
        const spec = pubspec(root);
        if (/^\s+http:/m.test(spec) && !/^\s+dio:/m.test(spec)) found.push('the http package (api add writes Dio code)');
        if (/^\s+chopper:/m.test(spec)) found.push('Chopper (api add writes Dio repositories or Retrofit clients)');
      }
      return found.length
        ? { status: 'warn', message: `Not supported yet: ${found.join('; ')}.`, hint: 'codz still runs; generated code follows its own style for these.' }
        : { status: 'pass', message: 'none found' };
    },
  },
  {
    id: 'formatter',
    run({ root, adapter }) {
      if (adapter.id === 'nextjs' || adapter.id === 'react-native') {
        return exists(join(root, 'node_modules/.bin/prettier')) || exists(join(root, 'node_modules/prettier'))
          ? { status: 'pass', message: 'prettier' }
          : { status: 'warn', message: 'Prettier is not installed in this project. Code is written in the detected style but not formatted.', hint: 'npm i -D prettier' };
      }
      if (adapter.id === 'flutter') {
        const v = has('dart');
        return v ? { status: 'pass', message: v } : { status: 'warn', message: 'Dart SDK not found. Code will be written but not formatted.', hint: 'Install Flutter and make sure dart is on your PATH.' };
      }
      return { status: 'pass', message: 'not needed' };
    },
  },
  {
    id: 'analyzer',
    run({ root, adapter }) {
      if (adapter.id === 'nextjs' || adapter.id === 'react-native') {
        return exists(join(root, 'node_modules/typescript'))
          ? { status: 'pass', message: 'typescript' }
          : { status: 'warn', message: 'typescript is not installed, so changes are not checked for compile errors after applying.', hint: 'npm install (TypeScript is in most Next.js projects already)' };
      }
      if (adapter.id === 'flutter') {
        if (!has('dart')) return { status: 'warn', message: 'Dart SDK not found, so changes are not analyzed after applying.', hint: 'Install Flutter.' };
        return exists(join(root, '.dart_tool/package_config.json'))
          ? { status: 'pass', message: 'dart analyze' }
          : { status: 'warn', message: 'flutter pub get has not been run, so dart analyze is skipped.', hint: 'flutter pub get' };
      }
      return { status: 'pass', message: 'not needed' };
    },
  },
  {
    id: 'scan_cache',
    run({ root }) {
      const path = join(root, TOOL_DIR, 'cache', 'map.json');
      if (!exists(path)) return { status: 'pass', message: 'no cache yet; it is built on the next command' };
      const cache = readJson<{ schema?: number; map?: unknown }>(path);
      if (!cache || !cache.map) return { status: 'warn', message: 'The scan cache is unreadable.', hint: 'It is rebuilt automatically; to force it now: codz explain --rescan' };
      return { status: 'pass', message: 'readable (rebuilt automatically when files or codz change)' };
    },
  },
  {
    id: 'history_state',
    run({ root }) {
      const leftovers = walk(root, '.', { maxFiles: 50000 }).filter((f) => f.endsWith('.codz-tmp'));
      if (leftovers.length) return { status: 'fail', message: `Half-written files from an interrupted apply: ${leftovers.slice(0, 3).join(', ')}.`, hint: 'Delete the .codz-tmp files; the real files were not replaced.' };
      const histPath = join(root, TOOL_DIR, 'history.json');
      if (!exists(histPath)) return { status: 'pass', message: 'no changes applied yet' };
      const hist = readJson<{ id: string; undone: boolean }[]>(histPath);
      if (!Array.isArray(hist)) return { status: 'fail', message: `${TOOL_DIR}/history.json is unreadable, so undo cannot work.`, hint: `Move ${TOOL_DIR}/history.json aside; codz starts a new history.` };
      const last = [...hist].reverse().find((h) => !h.undone);
      if (last && !exists(join(root, TOOL_DIR, 'backups', last.id))) return { status: 'warn', message: `The backup for the last change (${last.id}) is missing, so it cannot be undone.` };
      return { status: 'pass', message: `${hist.length} change${hist.length === 1 ? '' : 's'} in history` };
    },
  },
];

export function runSetupDoctor(root: string, adapter: Adapter): { checks: CheckResult[]; summary: Record<CheckStatus, number> } {
  const ctx: Ctx = { root, adapter, configText: readText(join(root, CONFIG_FILE)) };
  const checks = CHECKS.map((c) => {
    try {
      return { id: c.id, ...c.run(ctx) } as CheckResult;
    } catch (e) {
      return { id: c.id, status: 'warn', message: `The check could not run: ${(e as Error).message}` } as CheckResult;
    }
  });
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return { checks, summary };
}

export function renderSetupDoctor(r: ReturnType<typeof runSetupDoctor>, header: string, color: boolean): string {
  const paint = (s: CheckStatus, t: string) => (!color ? t : s === 'fail' ? `\x1b[31m${t}\x1b[0m` : s === 'warn' ? `\x1b[33m${t}\x1b[0m` : `\x1b[32m${t}\x1b[0m`);
  const width = Math.max(...r.checks.map((c) => c.id.length));
  const lines = [header];
  for (const c of r.checks) {
    lines.push(`  ${paint(c.status, c.status.padEnd(4))}  ${c.id.padEnd(width)}  ${c.message}`);
    if (c.hint && c.status !== 'pass') lines.push(`  ${' '.repeat(4)}  ${' '.repeat(width)}  → ${c.hint}`);
  }
  lines.push(`Summary: ${r.summary.pass} pass, ${r.summary.warn} warn, ${r.summary.fail} fail`);
  return lines.join('\n');
}
