// A small, strict reader (and a deterministic writer) for starter archives:
// gzip-compressed ustar holding regular files and folders only. Anything else
// (links, devices, FIFOs, GNU long names, global or unknown pax records,
// duplicate or unsafe paths) stops the read before a single byte is written.

import { gunzipSync, gzipSync } from 'node:zlib';
import { ToolError } from '../core/types.ts';
import { checkCollisions, checkRelPath, LIMITS } from './paths.ts';

export interface TarContents {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

const tooLarge = (what: string) => new ToolError('archive_too_large', `The archive exceeds a safety limit (${what}).`, 'Report it; nothing was written.');
const unsafe = (what: string) => new ToolError('archive_unsafe', `The archive has an unsafe entry: ${what}. Nothing was written.`, 'Do not use this template; report it.');
const broken = (what: string) => new ToolError('bad_template', `The archive is damaged: ${what}.`, 'Clear the cache with codz starters cache --clear and retry; report it if it persists.');

function field(b: Buffer, off: number, len: number): string {
  const raw = b.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function octal(b: Buffer, off: number, len: number, what: string): number {
  if (b[off] & 0x80) throw unsafe(`a binary-encoded ${what}`);
  const s = field(b, off, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw broken(`a bad ${what} field`);
  return parseInt(s, 8);
}

export function readTarGz(gz: Buffer): TarContents {
  if (gz.length > LIMITS.compressedBytes) throw tooLarge(`${LIMITS.compressedBytes / 1024 / 1024} MB compressed`);
  let tar: Buffer;
  try {
    // The cap stops a decompression bomb while it inflates, not after.
    tar = gunzipSync(gz, { maxOutputLength: LIMITS.expandedBytes + LIMITS.entries * 1024 + 1024 });
  } catch (e) {
    const msg = (e as Error).message;
    if (/maxOutputLength|buffer|too large/i.test(msg) || (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge(`${LIMITS.expandedBytes / 1024 / 1024} MB expanded`);
    throw broken('it is not a valid gzip file');
  }
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  let total = 0;
  let entries = 0;
  let paxPath: string | null = null;
  let off = 0;
  for (;;) {
    if (off + 512 > tar.length) throw broken('it ends in the middle of an entry');
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8, 'checksum')) throw broken('a header checksum does not match');
    const magic = field(h, 257, 6);
    if (magic !== 'ustar' && magic !== 'ustar ') throw broken('it is not a ustar archive');
    const type = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12, 'size');
    if (size > LIMITS.fileBytes) throw tooLarge(`one file over ${LIMITS.fileBytes / 1024 / 1024} MB`);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw broken('a file is cut short');
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (++entries > LIMITS.entries) throw tooLarge(`more than ${LIMITS.entries} entries`);

    if (type === 'x') {
      // Per-entry pax record: only a long path is accepted, plus harmless times and owners.
      paxPath = null;
      for (const [k, v] of parsePax(data)) {
        if (k === 'path') paxPath = v;
        else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(k)) throw unsafe(`an unsupported pax field "${k.slice(0, 40)}"`);
      }
      continue;
    }
    if (type === 'g') throw unsafe('a global pax header');
    if (type === 'L' || type === 'K') throw unsafe('a GNU long name record');
    if (type === '1' || type === '2') throw unsafe(`a ${type === '1' ? 'hard' : 'symbolic'} link`);
    if (type === '3' || type === '4' || type === '6') throw unsafe('a device file or FIFO');
    if (type !== '0' && type !== '5' && type !== '7') throw unsafe(`an entry of type "${type}"`);

    const prefix = field(h, 345, 155);
    let path = paxPath ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    paxPath = null;
    path = path.replace(/^(\.\/)+/, '');
    if (type === '5') {
      path = path.replace(/\/+$/, '');
      if (!path) continue;
      dirs.add(checkRelPath(path, 'archive'));
      continue;
    }
    checkRelPath(path, 'archive');
    if (files.has(path)) throw unsafe(`"${path}" appears twice`);
    total += size;
    if (total > LIMITS.expandedBytes) throw tooLarge(`${LIMITS.expandedBytes / 1024 / 1024} MB expanded`);
    files.set(path, Buffer.from(data));
  }
  checkCollisions([...files.keys()], 'archive');
  return { files, dirs };
}

function parsePax(data: Buffer): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) throw broken('a bad pax record');
    const len = Number(data.subarray(i, sp).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) throw broken('a bad pax record length');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq === -1) throw broken('a bad pax record');
    out.push([rec.slice(0, eq), rec.slice(eq + 1)]);
    i += len;
  }
  return out;
}

/**
 * Writes files (path → bytes) as a deterministic .tar.gz: sorted entries, no
 * folders, owner 0, time 0, mode 644 (755 for `executable`). The same input
 * gives the same bytes on every machine.
 */
export function writeTarGz(files: Map<string, Buffer>, executable: Set<string> = new Set()): Buffer {
  const blocks: Buffer[] = [];
  for (const path of [...files.keys()].sort()) {
    const data = files.get(path)!;
    const h = Buffer.alloc(512);
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = path.lastIndexOf('/', path.length - 1);
      const at = (() => {
        for (let i = cut; i > 0; i = path.lastIndexOf('/', i - 1)) if (Buffer.byteLength(path.slice(0, i)) <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100) return i;
        return -1;
      })();
      if (at === -1) throw new ToolError('bad_template', `${path} is too long for the archive format.`);
      prefix = path.slice(0, at);
      name = path.slice(at + 1);
    }
    h.write(name, 0, 100, 'utf8');
    h.write(executable.has(path) ? '0000755' : '0000644', 100, 8, 'ascii');
    h.write('0000000', 108, 8, 'ascii');
    h.write('0000000', 116, 8, 'ascii');
    h.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'ascii');
    h.write('00000000000', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h[156] = 48; // '0'
    h.write('ustar\u0000', 257, 6, 'binary');
    h.write('00', 263, 2, 'ascii');
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148, 8, 'binary');
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  gz[9] = 0xff; // gzip "OS" byte: unknown, so the bytes do not depend on where it was packed
  return gz;
}
