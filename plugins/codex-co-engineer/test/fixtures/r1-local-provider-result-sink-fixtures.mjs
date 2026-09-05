// Fixtures for the P11 local provider result sink tests.
//
// Pure data builders, tiny local helpers, and pinned secrets. Store-root
// helpers chmod 0700 after creation and never change process umask.

import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTIFACT_REF_SCHEMA_ID } from '../../mcp/v3/artifact-ref.mjs';
import {
  LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_MAX_BYTES,
} from '../../mcp/v3/local-provider-result-sink.mjs';

export const RUN_ID = 'run-p11-sink';
export const CHILD_A = 'lane-alpha';
export const CHILD_B = 'lane-beta';
export const CHILD_C = 'lane-gamma';

export const GROK_MODEL = 'grok-code';
export const CURSOR_MODEL = 'auto';
export const DSH_MODEL = 'meta/muse-spark-1.3-contributor';

export const SECRET = 'sk-live-secret-1234567890';
export const SPLIT_SECRET = 'sk-split-token-1234567890';
export const PROMPT_SECRET = 'do not echo this instruction';
export const REPLACEMENT = '[REDACTED]';

export const INLINE_TAIL_MAX = LOCAL_PROVIDER_RESULT_SINK_INLINE_TAIL_MAX_BYTES;

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeStoreRoot(prefix = 'cce-p11-sink-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix), { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

export function removeRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

export function identityFor(provider, overrides = {}) {
  const model = provider === 'dsh'
    ? DSH_MODEL
    : provider === 'cursor-local'
      ? CURSOR_MODEL
      : GROK_MODEL;
  return {
    run_id: RUN_ID,
    assignment_id: CHILD_A,
    provider,
    model,
    ...overrides,
  };
}

export function grokText(suffix = 'VERDICT: GROK PASS') {
  return `grok local acp output\n${suffix}`;
}

export function cursorText(suffix = 'VERDICT: CURSOR PASS') {
  return `cursor-local acp output\n${suffix}`;
}

export function dshObject(suffix = 'VERDICT: DSH OBJECT PASS') {
  return {
    progress: 'dsh-progress',
    nested: { final: suffix },
  };
}

export async function* chunksOf(bytes, size = 8) {
  const view = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  const width = Math.max(1, size);
  for (let offset = 0; offset < view.byteLength; offset += width) {
    yield view.subarray(offset, Math.min(offset + width, view.byteLength));
  }
}

export async function* splitStringChunks(text, at) {
  yield text.slice(0, at);
  yield text.slice(at);
}

export function exact4096(suffix = 'TAIL') {
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const prefix = 'a'.repeat(INLINE_TAIL_MAX - suffixBytes);
  return `${prefix}${suffix}`;
}

export function unicodeSplitWindow() {
  const wolf = '🐺';
  const prefix = 'p'.repeat(10);
  const suffix = 's'.repeat(4093);
  return `${prefix}${wolf}${suffix}`;
}

export function oversizeTail(suffix = 'VERDICT: OVERSIZE PASS') {
  return `${'x'.repeat(5000)}${suffix}`;
}

export function conflictingSanitizedRef(relativePath, bytes) {
  return {
    schema: ARTIFACT_REF_SCHEMA_ID,
    run_id: RUN_ID,
    assignment_id: CHILD_A,
    artifact_kind: 'provider_report',
    artifact_class: 'sanitized',
    relative_path: relativePath,
    byte_length: bytes.byteLength,
    sha256: digestOf(bytes),
    media_type: 'text/plain',
    content_encoding: 'identity',
  };
}

export class SubclassedBytes extends Uint8Array {}
