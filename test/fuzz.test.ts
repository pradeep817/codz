// Fuzz tests: parsers get thousands of malformed, truncated and random inputs
// built from a fixed seed (so failures reproduce). They may reject input with
// a ToolError, but must never crash with anything else, hang, or break their
// invariants (maskCode keeps length and line breaks; matchBrace stays in range).
// More runs: FUZZ_RUNS=5000 FUZZ_SEED=3 node --test test/fuzz.test.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { maskCode, matchBrace } from '../src/adapters/source.ts';
import { mergeDart, mergeTsDocs } from '../src/core/merge.ts';
import { ToolError } from '../src/core/types.ts';
import { parse as parseYaml } from '../src/core/yaml.ts';
import { readApiFile } from '../src/input/apiSpec.ts';
import { parseCurl, shellSplit } from '../src/input/curl.ts';
import { buildEndpoint } from '../src/input/endpoint.ts';
import { detectPaste } from '../src/input/paste.ts';
import { INPUTS } from './helpers.ts';

/** mulberry32: small, fast, deterministic. */
function rng(seed: number) {
  let a = (seed + Number(process.env.FUZZ_SEED ?? 0) * 7919) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['{', '}', '(', ')', '[', ']', '"', "'", '`', '\\', '/', '*', '//', '/*', '*/', '${', '$', '\n', ' ', '\t', ':', ',', ';', '-', '--', '=', '#', 'r"', "r'", "'''", '"""', '<', '>', '?', 'é', '😀', '\u0000'];

function mutate(r: () => number, base: string, n: number): string {
  let s = base;
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r() * (s.length + 1));
    const op = r();
    if (op < 0.4) s = s.slice(0, at) + PIECES[Math.floor(r() * PIECES.length)] + s.slice(at);
    else if (op < 0.7) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 5));
    else if (op < 0.85) s = s.slice(0, at);
    else s = s.slice(0, at) + s.slice(Math.floor(r() * s.length)); // splice a random tail
  }
  return s;
}

function randomText(r: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += r() < 0.6 ? PIECES[Math.floor(r() * PIECES.length)] : String.fromCharCode(32 + Math.floor(r() * 90));
  return s;
}

/** Runs fn; a ToolError is an accepted rejection, anything else fails the test with the input. */
function survives(name: string, input: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return;
    assert.fail(`${name} crashed on ${JSON.stringify(input.slice(0, 300))}: ${(e as Error).stack}`);
  }
}

const N = Number(process.env.FUZZ_RUNS ?? 400);
const TS_SAMPLE = "import { a } from './a';\nexport async function f(x: number): Promise<A> {\n  const s = `x ${y + '}'} z`; // }\n  return { a: '{', b: /re}/ };\n}\n";
const DART_SAMPLE = "class A {\n  const A({required this.id});\n  final int id;\n  String get s => '${id} }';\n  /* } */\n  factory A.fromJson(Map<String, dynamic> j) => A(id: j['id'] as int);\n}\n";

describe('fuzz: source scanning', () => {
  it('maskCode keeps length and line breaks for any input, TS and Dart', () => {
    const r = rng(1);
    for (let i = 0; i < N; i++) {
      for (const [lang, base] of [['ts', TS_SAMPLE], ['dart', DART_SAMPLE]] as const) {
        const input = i % 3 === 0 ? randomText(r, 1 + Math.floor(r() * 200)) : mutate(r, base, 1 + Math.floor(r() * 12));
        survives('maskCode', input, () => {
          const m = maskCode(input, lang);
          assert.equal(m.length, input.length, `length changed for ${JSON.stringify(input)}`);
          assert.equal(m.split('\n').length, input.split('\n').length, `line count changed for ${JSON.stringify(input)}`);
        });
      }
    }
  });

  it('matchBrace returns -1 or a matching closer, never out of range', () => {
    const r = rng(2);
    for (let i = 0; i < N; i++) {
      const input = mutate(r, i % 2 ? TS_SAMPLE : DART_SAMPLE, 1 + Math.floor(r() * 10));
      const opens = [...input.matchAll(/[{([]/g)].map((m) => m.index!);
      for (const o of opens.slice(0, 5)) {
        survives('matchBrace', input, () => {
          const c = matchBrace(input, o, i % 2 ? 'ts' : 'dart');
          assert.ok(c === -1 || (c > o && c < input.length && ')]}'.includes(input[c])), `bad result ${c} for ${JSON.stringify(input)}`);
        });
      }
    }
  });

  it('merges survive broken old and new files', () => {
    const r = rng(3);
    for (let i = 0; i < N / 2; i++) {
      const a = mutate(r, DART_SAMPLE, Math.floor(r() * 8));
      const b = mutate(r, DART_SAMPLE.replace('final int id;', 'final int id;\n  final String name;'), Math.floor(r() * 8));
      survives('mergeDart', a + '|' + b, () => void mergeDart(a, b));
      survives('mergeTsDocs', a + '|' + b, () => void mergeTsDocs(mutate(r, 'export interface U {\n  /** id */\n  id: number;\n}\n', 3), mutate(r, 'export interface U {\n  id: number;\n  name: string;\n}\n', 3)));
    }
  });
});

describe('fuzz: inputs', () => {
  it('cURL commands and pastes', () => {
    const r = rng(4);
    const base = readFileSync(join(INPUTS, 'order-curl.txt'), 'utf8');
    for (let i = 0; i < N; i++) {
      const input = i % 4 === 0 ? `curl ${randomText(r, 60)}` : mutate(r, base, 1 + Math.floor(r() * 15));
      survives('shellSplit', input, () => void shellSplit(input));
      survives('parseCurl', input, () => void parseCurl(input));
      survives('detectPaste', input, () => void detectPaste(input));
    }
  });

  it('API spec files: OpenAPI YAML, Swagger and Postman JSON, HAR', () => {
    const r = rng(5);
    const bases = ['shop-openapi.yaml', 'petstore-swagger.json', 'shop-postman.json', 'shop.har'].map((f) => readFileSync(join(INPUTS, f), 'utf8'));
    for (let i = 0; i < N; i++) {
      const input = mutate(r, bases[i % bases.length], 1 + Math.floor(r() * 6));
      survives('readApiFile', input, () => void readApiFile(input));
    }
  });

  it('YAML config', () => {
    const r = rng(6);
    const base = 'framework: nextjs\nconventions:\n  quote: single\n  # comment\n  apiFolder: lib/api\n  list:\n    - a\n    - "b: c"\n';
    for (let i = 0; i < N; i++) {
      const input = mutate(r, base, 1 + Math.floor(r() * 10));
      survives('yaml.parse', input, () => void parseYaml(input));
    }
  });

  it('response samples of any shape infer a model', () => {
    const r = rng(7);
    const gen = (d: number): unknown => {
      const k = r();
      if (d > 4 || k < 0.2) return [null, true, 1, 1.5, 'x', '2026-01-01T00:00:00Z', ''][Math.floor(r() * 7)];
      if (k < 0.5) return Array.from({ length: Math.floor(r() * 3) }, () => gen(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(r() * 4) }, () => [randomText(r, 1 + Math.floor(r() * 6)) || 'k', gen(d + 1)]));
    };
    for (let i = 0; i < N; i++) {
      const samples = [gen(0), gen(0)];
      survives('buildEndpoint', JSON.stringify(samples), () => void buildEndpoint({ method: 'GET', url: new URL('https://api.test/v1/things/:id'), responseSamples: samples, unwrap: 'auto' }));
    }
  });
});
