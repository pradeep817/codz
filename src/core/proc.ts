// Runs a project tool (flutter, npx, gradle, dart, the formatter...). On Windows
// most of these are .cmd or .bat files, which only start through cmd.exe, and
// cmd.exe splits on spaces: so there the command line is built here with every
// argument quoted (paths like "C:\Users\Jo Doe\app" survive), instead of
// letting Node join the arguments unquoted. An absolute path to an .exe (node
// itself) runs directly, without a shell.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process';

/** Quotes one argument for cmd.exe + the C runtime's argument parser. */
export function winQuote(arg: string): string {
  if (arg !== '' && !/[\s"&|<>^()%!,;=]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export function runTool(cmd: string, args: string[], opts: Omit<SpawnSyncOptionsWithStringEncoding, 'shell' | 'encoding'> = {}): SpawnSyncReturns<string> {
  const options: SpawnSyncOptionsWithStringEncoding = { ...opts, encoding: 'utf8' };
  if (process.platform !== 'win32' || /^[a-zA-Z]:[\\/].*\.exe$/i.test(cmd)) return spawnSync(cmd, args, options);
  return spawnSync([cmd, ...args].map(winQuote).join(' '), { ...options, shell: true });
}

/** True when a runTool result means the program is not installed (ENOENT, or cmd.exe's "not recognized"). */
export function toolMissing(r: SpawnSyncReturns<string>): boolean {
  return (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (process.platform === 'win32' && r.status !== 0 && /is not recognized as an internal or external command/i.test(r.stderr ?? ''));
}
