#!/usr/bin/env node
// Publishing tool for starter templates (internal; not part of the codz CLI).
//
//   node scripts/starters.ts keygen <dir>                       new Ed25519 signing key (keep the private key offline)
//   node scripts/starters.ts files <template>                   refresh manifest.json's file list from files/
//   node scripts/starters.ts check <template>...                publishing gates that need no SDK (exit 1 on errors)
//   node scripts/starters.ts pack <template> <registry>         check, then write v1/templates/<id>/<version>/
//   node scripts/starters.ts index <registry> --key <pem>...    build and sign v1/index.json from catalog.json (--days 7)
//        [--timestamp-key <pub>]...                             two-key catalog: let an online key confirm freshness (then use --days 180)
//   node scripts/starters.ts timestamp <registry> --key <pem>   sign v1/timestamp.json with the online key (--hours 48)
//
// The SDK gates (flutter analyze/test/build, next build), the init contract and
// the api add smoke test run in CI on a project made with codz new.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/cli.ts';
import { buildIndex, checkTemplate, packTemplate, refreshFileList, signTimestamp } from '../src/starters/publish.ts';
import { generateKeys } from '../src/starters/sign.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.flatMap((a, i) => (a === `--${name}` && rest[i + 1] ? [rest[i + 1]] : []));
const args = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

try {
  switch (cmd) {
    case 'keygen': {
      const dir = args[0] ?? '.';
      mkdirSync(dir, { recursive: true });
      const k = generateKeys();
      writeFileSync(join(dir, `starters-${k.keyid}.pem`), k.privatePem, { mode: 0o600 });
      chmodSync(join(dir, `starters-${k.keyid}.pem`), 0o600);
      writeFileSync(join(dir, `starters-${k.keyid}.pub`), `${k.publicRaw}\n`);
      console.log(`Key id ${k.keyid}\nPublic key (put it in OFFICIAL_KEYS or CODZ_REGISTRY_KEYS): ${k.publicRaw}\nPrivate key: ${join(dir, `starters-${k.keyid}.pem`)} — keep it offline.`);
      break;
    }
    case 'files':
      for (const t of args) console.log(`${t}: ${refreshFileList(t)} files listed`);
      break;
    case 'check': {
      let failed = false;
      for (const t of args) {
        const r = checkTemplate(t, VERSION);
        console.log(`${r.id} ${r.version}: ${r.errors.length ? `${r.errors.length} error(s)` : 'ok'}${r.warnings.length ? `, ${r.warnings.length} warning(s)` : ''}`);
        for (const e of r.errors) console.log(`  ✗ ${e}`);
        for (const w of r.warnings) console.log(`  ! ${w}`);
        failed ||= r.errors.length > 0;
      }
      process.exit(failed ? 1 : 0);
    }
    // falls through (unreachable)
    case 'pack': {
      const [t, out] = args;
      const r = checkTemplate(t, VERSION);
      if (r.errors.length) {
        for (const e of r.errors) console.log(`✗ ${e}`);
        process.exit(1);
      }
      const p = packTemplate(t, out);
      console.log(`${p.id} ${p.version}\n  archive  ${p.archiveSha256}\n  manifest ${p.manifestSha256}\n  ${p.archive}`);
      break;
    }
    case 'index': {
      const keys = flag('key').map((f) => readFileSync(f, 'utf8'));
      if (!keys.length) throw new Error('Pass --key <private.pem> (repeat to sign with several keys).');
      const tsKeys = flag('timestamp-key').map((f) => readFileSync(f, 'utf8').trim());
      const idx = buildIndex(args[0], keys, { days: Number(flag('days')[0] ?? (tsKeys.length ? 180 : 7)), timestampKeys: tsKeys });
      console.log(`index seq ${idx.seq}, ${idx.templates.length} starters, expires ${idx.expires}${tsKeys.length ? `; freshness confirmed by ${tsKeys.length} online key(s): sign v1/timestamp.json now (the store does it for you)` : ''}`);
      break;
    }
    case 'timestamp': {
      const key = flag('key')[0];
      if (!key) throw new Error('Pass --key <online-key.pem>.');
      const r = signTimestamp(args[0], readFileSync(key, 'utf8'), { hours: Number(flag('hours')[0] ?? 48) });
      console.log(`timestamp for index seq ${r.seq}, valid until ${r.expires}`);
      break;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
