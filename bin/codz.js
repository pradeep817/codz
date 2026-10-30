#!/usr/bin/env node
// Entry point. Installed from npm, codz runs the compiled dist/ (Node 20+).
// From a checkout, it runs the TypeScript in src/ directly (Node 22.18+), or
// dist/ when CODZ_DIST=1 or Node cannot run TypeScript.
import { existsSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const hasSrc = existsSync(new URL('../src/cli.ts', here));
const hasDist = existsSync(new URL('../dist/cli.js', here));
const [major, minor] = process.versions.node.split('.').map(Number);
const canRunTs = major > 22 || (major === 22 && minor >= 18);
const useDist = hasDist && (!hasSrc || !canRunTs || process.env.CODZ_DIST === '1');
if (!useDist && !canRunTs) {
  console.error(`codz needs Node 22.18+ to run from source (this is Node ${process.versions.node}). Run npm run build, or upgrade Node.`);
  process.exit(1);
}
const { main } = await import(useDist ? '../dist/cli.js' : '../src/cli.ts');

// Exit quietly when output is piped into a command that stops reading (e.g. head).
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? (process.env.CODZ_DEBUG ? err.stack : err.message) : String(err));
    process.exitCode = 1;
  },
);
