// Writes docs/COMMANDS.md from the command table (src/core/commands.ts).
// Usage: npm run docs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../src/core/commands.ts';
import { VERSION } from '../src/cli.ts';

const file = join(import.meta.dirname, '..', 'docs', 'COMMANDS.md');
writeFileSync(file, renderMarkdown(VERSION));
console.log(`Wrote ${file}`);
