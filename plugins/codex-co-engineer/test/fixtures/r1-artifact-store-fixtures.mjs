// Shared fixtures for the W4-P08 atomic artifact store tests.
//
// Pure data builders plus tiny local helpers over the caller's own temporary
// directories. The only product imports are the two accepted P07 modules, so
// fixtures cannot mask a store defect with store-owned code.

import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_REF_SCHEMA_ID,
} from '../../mcp/v3/artifact-ref.mjs';

export const RUN_ID = 'run-store-01';
export const CHILD_A = 'lane-alpha';
export const CHILD_B = 'lane-beta';

const SHA_A = 'aa'.repeat(32);

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// A private fresh store root under the system temporary directory.
export function makeStoreRoot(prefix = 'cce-p08-store-') {
  return mkdtempSync(path.join(tmpdir(), prefix), { mode: 0o700 });
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

export function refFor(bytes, overrides = {}) {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: CHILD_A,
    artifact_kind: 'git_diff',
    artifact_class: 'sanitized',
    relative_path: `runs/${RUN_ID}/${CHILD_A}/diff.patch`,
    byte_length: bytes.length,
    sha256: digestOf(bytes),
    media_type: 'text/plain',
    content_encoding: 'identity',
    ...overrides,
  };
}

export const staticRef = (overrides = {}) => refFor(Buffer.from('fixture bytes'), overrides);

// ---- Byte sources ----------------------------------------------------------

export function chunksOf(bytes, count = 3) {
  const size = Math.max(1, Math.ceil(bytes.length / count));
  async function* generate() {
    for (let offset = 0; offset < bytes.length; offset += size) {
      yield bytes.subarray(offset, Math.min(offset + size, bytes.length));
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

// Yields only `keep` of the declared `total` bytes: a short stream.
export function shortSource(total, keep = 1) {
  async function* generate() {
    yield Buffer.alloc(Math.min(keep, total), 0x61);
  }
  return generate();
}

// An endless stream of one-byte chunks: only the class cap may stop it.
export function endlessSource(fill = 0x62) {
  async function* generate() {
    while (true) {
      yield Buffer.alloc(1, fill);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return generate();
}

// A stream that grows past any declared length but stays inside raw caps.
export function growingSource(target) {
  async function* generate() {
    let sent = 0;
    while (sent < target + 4096) {
      yield Buffer.alloc(64, 0x63);
      sent += 64;
      await new Promise((resolve) => setImmediate(resolve));
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

// Mid-publication sabotage: after the first chunk, run an arbitrary side
// effect against the filesystem, then keep streaming. This deterministically
// interleaves hostile tree mutation into the middle of a publication.
export function sabotagingSource(sideEffect) {
  async function* generate() {
    yield Buffer.from('first chunk');
    await sideEffect();
    yield Buffer.from('second chunk');
  }
  return generate();
}

// Accessor-dressed async iterable: Symbol.asyncIterator is a getter whose
// trap records that it ran. Accepting this would execute caller code.
export function accessorIterable(trapLog) {
  return {
    get [Symbol.asyncIterator]() {
      trapLog.iteratorGetter += 1;
      throw new Error('accessor iterator getter must never run');
    },
  };
}

// A subclassed view: prototype is neither Uint8Array.prototype nor
// Buffer.prototype, so its length surface is not intrinsic.
export class SubclassedBytes extends Uint8Array {}
