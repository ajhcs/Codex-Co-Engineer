// Fixtures for the W5-P09 streaming artifact sanitizer tests.
//
// Pure data builders, tiny local helpers, and pinned expected projections.
// Store-root helpers use the caller's temporary directory only. Product
// imports are limited to the accepted P07 schema id so fixtures cannot mask
// a sanitizer defect with sanitizer-owned code.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTIFACT_REF_SCHEMA_ID } from '../../mcp/v3/artifact-ref.mjs';

export const RUN_ID = 'run-sanitize-01';
export const CHILD_A = 'lane-alpha';
export const CHILD_B = 'lane-beta';

export const REPLACEMENT = '[REDACTED]';

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeStoreRoot(prefix = 'cce-p09-sanitizer-') {
  return mkdtempSync(path.join(tmpdir(), prefix), { mode: 0o700 });
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

export function rawRefFor(bytes, overrides = {}) {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: CHILD_A,
    artifact_kind: 'git_diff',
    artifact_class: 'raw',
    relative_path: `runs/${RUN_ID}/${CHILD_A}/artifact.txt`,
    byte_length: bytes.byteLength,
    sha256: digestOf(bytes),
    media_type: 'text/plain',
    content_encoding: 'identity',
    ...overrides,
  };
}

export function chunksOf(bytes, count = 3) {
  const size = Math.max(1, Math.ceil(bytes.byteLength / count));
  async function* generate() {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength));
    }
  }
  return generate();
}

export function splitAt(bytes, offset) {
  const point = Math.max(0, Math.min(offset, bytes.byteLength));
  async function* generate() {
    if (point > 0) yield bytes.subarray(0, point);
    if (point < bytes.byteLength) yield bytes.subarray(point);
  }
  return generate();
}

export function byteSplits(bytes) {
  async function* generate() {
    for (let offset = 0; offset < bytes.byteLength; offset += 1) {
      yield bytes.subarray(offset, offset + 1);
    }
  }
  return generate();
}

export function emptyStream() {
  async function* generate() {}
  return generate();
}

export function stringChunkSource(text = 'text not bytes') {
  async function* generate() { yield text; }
  return generate();
}

export function shortSource(total, keep = 1) {
  async function* generate() {
    yield Buffer.alloc(Math.min(keep, total), 0x61);
  }
  return generate();
}

export function endlessSource(fill = 0x61) {
  async function* generate() {
    while (true) {
      yield Buffer.alloc(4096, fill);
    }
  }
  return generate();
}

export function throwingSource(failure) {
  async function* generate() {
    yield Buffer.from('first chunk');
    throw failure;
  }
  return generate();
}

export function accessorIterable(trapLog) {
  return {
    get [Symbol.asyncIterator]() {
      trapLog.iteratorGetter += 1;
      throw new Error('accessor iterator getter must never run');
    },
  };
}

export class SubclassedBytes extends Uint8Array {}

// ---- Pinned secret samples and their expected projections. -----------------

export const SAMPLES = Object.freeze({
  plain: Object.freeze({
    raw: Buffer.from('authoritative artifact text for P09\n', 'utf8'),
    sanitized: Buffer.from('authoritative artifact text for P09\n', 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  credentialFormat: Object.freeze({
    raw: Buffer.from('token sk-live-secret-1234567890 trailing\n', 'utf8'),
    sanitized: Buffer.from(`token ${REPLACEMENT} trailing\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 1,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  bearer: Object.freeze({
    raw: Buffer.from('Authorization: Bearer abcdefghijklmnop.qrstuv\n', 'utf8'),
    sanitized: Buffer.from(`Authorization: Bearer ${REPLACEMENT}\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 1,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  envAssignment: Object.freeze({
    raw: Buffer.from('export API_KEY=super-secret-value\n', 'utf8'),
    sanitized: Buffer.from(`export API_KEY=${REPLACEMENT}\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 0,
      env_assignments: 1,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  urlCredential: Object.freeze({
    raw: Buffer.from('clone https://user:passwd@example.test/repo.git\n', 'utf8'),
    sanitized: Buffer.from(`clone https://${REPLACEMENT}@example.test/repo.git\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 1,
      prompts: 0,
    }),
  }),
  prompt: Object.freeze({
    raw: Buffer.from('{"prompt": "do not echo this instruction"}\n', 'utf8'),
    sanitized: Buffer.from(`{"prompt": ${REPLACEMENT}}\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 1,
    }),
  }),
  mixed: Object.freeze({
    raw: Buffer.from(
      'Bearer abcdefghijklmnop API_KEY=xyz https://u:p@host sk-abcdefghijkl prompt: "secret"\n',
      'utf8',
    ),
    sanitized: Buffer.from(
      `Bearer ${REPLACEMENT} API_KEY=${REPLACEMENT} https://${REPLACEMENT}@host ${REPLACEMENT} prompt: ${REPLACEMENT}\n`,
      'utf8',
    ),
    counts: Object.freeze({
      credential_formats: 1,
      bearer_credentials: 1,
      env_assignments: 1,
      url_credentials: 1,
      prompts: 1,
    }),
  }),
  github: Object.freeze({
    raw: Buffer.from('ghs_abcdefghijklmnop and github_pat_abcdefghijklmnop\n', 'utf8'),
    sanitized: Buffer.from(`${REPLACEMENT} and ${REPLACEMENT}\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 2,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  aws: Object.freeze({
    raw: Buffer.from('id AKIAIOSFODNN7EXAMPLE extra\n', 'utf8'),
    sanitized: Buffer.from(`id ${REPLACEMENT} extra\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 1,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  cursorKey: Object.freeze({
    raw: Buffer.from('key crsr_abcdefghijkl extra\n', 'utf8'),
    sanitized: Buffer.from(`key ${REPLACEMENT} extra\n`, 'utf8'),
    counts: Object.freeze({
      credential_formats: 1,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
  astral: Object.freeze({
    raw: Buffer.from('wolf 🐺 and café\n', 'utf8'),
    sanitized: Buffer.from('wolf 🐺 and café\n', 'utf8'),
    counts: Object.freeze({
      credential_formats: 0,
      bearer_credentials: 0,
      env_assignments: 0,
      url_credentials: 0,
      prompts: 0,
    }),
  }),
});

export const MALFORMED_RAW = Buffer.from([0x61, 0xff, 0x62, 0x0a]);
export const MALFORMED_SANITIZED = Buffer.from('a\uFFFDb\n', 'utf8');

// U+D800 encoded as UTF-8 (ED A0 80) is malformed; decoder emits U+FFFD.
export const UNPAIRED_RAW = Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x62, 0x0a]);
export const UNPAIRED_SANITIZED = Buffer.from('a\uFFFDb\n', 'utf8');
