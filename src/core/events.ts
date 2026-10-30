// A local log of which codz commands ran and how they ended, for `codz
// report` (beta feedback). It holds the command name, success or the error
// code, and the time taken: never arguments, code, file names or URLs. It stays
// in the project's .codz/ folder and is never sent anywhere. It is written
// only where codz already has its .codz/ folder, and
// CODZ_NO_EVENTS=1 turns it off.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DIR } from './cache.ts';

export interface CodzEvent {
  /** ISO time. */
  t: string;
  /** "feature add", "api import", ... */
  cmd: string;
  ok: boolean;
  /** ToolError code, or "internal" for a crash. */
  code?: string;
  ms: number;
  v: string;
}

const MAX_EVENTS = 5000;

const eventsFile = (root: string) => join(root, TOOL_DIR, 'events.jsonl');

export function recordEvent(root: string, ev: CodzEvent): void {
  if (process.env.CODZ_NO_EVENTS === '1') return;
  try {
    // Only where codz already keeps its folder (made by the first scan or change); never a new folder.
    if (!existsSync(join(root, TOOL_DIR))) return;
    const file = eventsFile(root);
    appendFileSync(file, `${JSON.stringify(ev)}\n`);
    // Keep the newest events only.
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_EVENTS * 1.2) writeFileSync(file, `${lines.slice(-MAX_EVENTS).join('\n')}\n`);
  } catch {
    // The log is a convenience; it never makes a command fail.
  }
}

export function readEvents(root: string): CodzEvent[] {
  try {
    return readFileSync(eventsFile(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CodzEvent)
      .filter((e) => e && typeof e.cmd === 'string');
  } catch {
    return [];
  }
}
