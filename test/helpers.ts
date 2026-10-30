import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(REPO, 'fixtures');
export const INPUTS = join(REPO, 'test', 'inputs');
export const GOLDEN = join(REPO, 'test', 'golden');
export const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Copies a fixture into a fresh temp folder and returns its path. */
export function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `codz-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function input(name: string): string {
  return readFileSync(join(INPUTS, name), 'utf8');
}

/** Compares text with a golden file, or writes it when UPDATE_GOLDEN=1. */
export function golden(relPath: string, actual: string): void {
  const path = join(GOLDEN, relPath);
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  let expected: string;
  try {
    expected = readFileSync(path, 'utf8');
  } catch {
    assert.fail(`Missing golden file ${relPath}. Run: npm run test:update-golden`);
  }
  assert.equal(actual, expected, `Output differs from golden file ${relPath}. If the change is intended, run: npm run test:update-golden`);
}
