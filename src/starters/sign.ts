// Ed25519 signatures with Node's built-in crypto. A signature file sits next
// to the signed file (index.json → index.json.sig) and signs its exact bytes,
// never a re-serialised copy. It may hold several signatures, so a new key can
// be added before an old one is retired.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { ToolError } from '../core/types.ts';
import { parseStrictJson } from './strictJson.ts';

/**
 * Public keys this codz release trusts for the official catalog, by key id.
 * Empty until the catalog is live; a registry set with CODZ_REGISTRY brings
 * its own keys in CODZ_REGISTRY_KEYS.
 */
export const OFFICIAL_KEYS: Record<string, string> = {};

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) throw new ToolError('signature_invalid', 'A trusted key is not a 32-byte Ed25519 public key.', 'Check CODZ_REGISTRY_KEYS.');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function keyId(rawBase64: string): string {
  return createHash('sha256').update(Buffer.from(rawBase64, 'base64')).digest('hex').slice(0, 16);
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface SignatureFile {
  signatures: { keyid: string; sig: string }[];
}

/** Throws signature_invalid unless at least one signature by a trusted key verifies over `data`. */
export function verifySignature(data: Buffer, sigFile: Buffer, trusted: Record<string, string>, what: string): string {
  const fail = (why: string): never => {
    throw new ToolError('signature_invalid', `The signature of ${what} could not be verified (${why}).`, 'Update codz; if it persists, do not use the catalog and report it.');
  };
  if (!Object.keys(trusted).length) fail('this codz trusts no catalog keys');
  let parsed: unknown;
  try {
    parsed = parseStrictJson(sigFile.toString('utf8'), `${what} signature`, { maxBytes: 16 * 1024 });
  } catch {
    return fail('the signature file is not valid');
  }
  const sigs = (parsed as SignatureFile)?.signatures;
  if (!Array.isArray(sigs) || !sigs.length || sigs.length > 8) fail('no signatures');
  for (const s of sigs) {
    if (typeof s?.keyid !== 'string' || typeof s?.sig !== 'string') continue;
    const raw = trusted[s.keyid];
    if (!raw) continue;
    const sig = Buffer.from(s.sig, 'base64');
    if (sig.length !== 64) continue;
    if (verify(null, data, publicKeyFromRaw(raw), sig)) return s.keyid;
  }
  return fail('no signature from a trusted key matches');
}

// ---------- Publishing side (scripts/starters.ts and tests) ----------

export function generateKeys(): { privatePem: string; publicRaw: string; keyid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicRaw = der.subarray(SPKI_PREFIX.length).toString('base64');
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicRaw, keyid: keyId(publicRaw) };
}

export function signBytes(data: Buffer, privatePem: string): { keyid: string; sig: string } {
  const key = createPrivateKey(privatePem);
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  return { keyid: keyId(der.subarray(SPKI_PREFIX.length).toString('base64')), sig: sign(null, data, key).toString('base64') };
}

export function signatureFile(data: Buffer, privatePems: string[]): Buffer {
  return Buffer.from(JSON.stringify({ signatures: privatePems.map((p) => signBytes(data, p)) }, null, 2) + '\n');
}
