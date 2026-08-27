// P33 run artifact bridge adversarial coverage: hostile containers, identity
// drift, path-authority broadening, credential leaks, lying stores, and
// content-free failures.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTIFACT_REF_SCHEMA_ID } from '../mcp/v3/artifact-ref.mjs';
import { createRunArtifactBridge } from '../mcp/v3/run-artifact-bridge.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  ASSIGNMENT_A,
  FOREIGN_RELATIVE,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  HOSTILE_TOKEN,
  OTHER_RUN_ID,
  RELATIVE_A,
  RUN_ID,
  captureInput,
  cleanupInput,
  digestOf,
  makeBridge,
  makeClock,
  makeEvidenceBundle,
  makeRawStore,
  makeSanitizer,
  projectInput,
} from './fixtures/r1-run-artifact-bridge-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertContentFree(error) {
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /github_pat/u);
  assert.doesNotMatch(error.message, /\/tmp\//u);
  assert.doesNotMatch(error.message, /Bearer /u);
}

test('proxy factory options and capture inputs fail closed without traps', async () => {
  const proxiedOptions = countingProxy({
    rawStore: makeRawStore(),
    sanitizer: makeSanitizer(),
    evidenceBundle: makeEvidenceBundle(),
    clock: makeClock(),
  });
  assert.throws(() => createRunArtifactBridge(proxiedOptions.proxy), (error) => {
    assert.ok(error instanceof RunContractV1Error);
    assert.equal(error.code, 'proxy_denied');
    return true;
  });
  assert.equal(trapTotal(proxiedOptions.counts), 0);

  const { bridge } = makeBridge();
  const proxiedInput = countingProxy(captureInput());
  const error = await errorOf(() => bridge.captureAssignmentArtifacts(proxiedInput.proxy));
  assert.equal(error.code, 'proxy_denied');
  assert.equal(trapTotal(proxiedInput.counts), 0);
  assertContentFree(error);
});

test('unknown factory keys and missing store methods fail closed', () => {
  const base = {
    rawStore: makeRawStore(),
    sanitizer: makeSanitizer(),
    evidenceBundle: makeEvidenceBundle(),
    clock: makeClock(),
  };
  assert.throws(() => createRunArtifactBridge({ ...base, scheduler: {} }), (error) => {
    assert.equal(error.code, 'unknown_key');
    return true;
  });
  const rawStore = makeRawStore();
  delete rawStore.remove;
  assert.throws(() => createRunArtifactBridge({ ...base, rawStore }), (error) => {
    assert.equal(error.code, 'missing_key');
    return true;
  });
});

test('accessor and symbol keys never run getters or leak secrets', async () => {
  const { bridge } = makeBridge();
  const hostile = {
    ...captureInput(),
    get source() {
      throw new Error(`trap ${HOSTILE_SECRET}`);
    },
  };
  delete hostile.source;
  Object.defineProperty(hostile, 'source', {
    enumerable: true,
    get() {
      throw new Error(`trap ${HOSTILE_SECRET}`);
    },
  });
  const accessorError = await errorOf(() => bridge.captureAssignmentArtifacts(hostile));
  assert.equal(accessorError.code, 'accessor_property_denied');
  assertContentFree(accessorError);

  const withSymbol = captureInput();
  withSymbol[Symbol('secret')] = HOSTILE_TOKEN;
  const symbolError = await errorOf(() => bridge.captureAssignmentArtifacts(withSymbol));
  assert.equal(symbolError.code, 'symbol_key_denied');
  assertContentFree(symbolError);
});

test('path authority cannot broaden to another run or parent segments', async () => {
  const { bridge, rawStore } = makeBridge();
  const foreign = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    relative_path: FOREIGN_RELATIVE,
  })));
  assert.equal(foreign.code, 'artifact_bridge_path_authority_denied');
  assertContentFree(foreign);
  assert.equal(rawStore.size(), 0);

  const escaped = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    relative_path: 'runs/run-artifact-main/assign-a/../../secret.txt',
  })));
  assert.ok([
    'artifact_bridge_path_authority_denied',
    'alias_segment_denied',
  ].includes(escaped.code));
  assertContentFree(escaped);
});

test('cleanup without exact run proof is denied and leaves artifacts in place', async () => {
  const { bridge, rawStore } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput());
  const missing = await errorOf(() => bridge.cleanupRunArtifacts({ run_id: RUN_ID }));
  assert.equal(missing.code, 'missing_key');
  const mismatched = await errorOf(() => bridge.cleanupRunArtifacts(cleanupInput({
    proof: { run_id: OTHER_RUN_ID },
  })));
  assert.equal(mismatched.code, 'artifact_bridge_cleanup_unproven');
  assertContentFree(mismatched);
  const worktree = await errorOf(() => bridge.cleanupRunArtifacts({
    run_id: RUN_ID,
    proof: { run_id: RUN_ID, worktree: HOSTILE_PATH },
  }));
  assert.equal(worktree.code, 'unknown_key');
  assertContentFree(worktree);
  assert.equal(rawStore.size(), 1);
});

test('a lying store that lists another run cannot cause escaped cleanup', async () => {
  const inner = makeRawStore();
  const honest = makeBridge({ rawStore: inner });
  await honest.bridge.captureAssignmentArtifacts(captureInput());
  const lying = {
    publish: inner.publish.bind(inner),
    get: inner.get.bind(inner),
    remove: inner.remove.bind(inner),
    async list({ run_id }) {
      const own = await inner.list({ run_id });
      own.push({
        artifact_ref: {
          schema: ARTIFACT_REF_SCHEMA_ID,
          run_id: OTHER_RUN_ID,
          assignment_id: ASSIGNMENT_A,
          artifact_kind: 'provider_report',
          artifact_class: 'raw',
          relative_path: FOREIGN_RELATIVE,
          byte_length: 4,
          sha256: digestOf(Buffer.from('nope')),
          media_type: 'text/plain',
          content_encoding: 'identity',
        },
        bytes: Buffer.from('nope'),
      });
      return own;
    },
  };
  const { bridge } = makeBridge({ rawStore: lying });
  const error = await errorOf(() => bridge.cleanupRunArtifacts(cleanupInput()));
  assert.equal(error.code, 'artifact_bridge_run_escape_denied');
  assertContentFree(error);
  const stored = await inner.get({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    relative_path: RELATIVE_A,
  });
  assert.equal(stored !== null, true);
  assert.equal(inner.size(), 1);
});

test('sanitizer returning raw class or credential text fails closed', async () => {
  const rawClassSanitizer = {
    async sanitize({ artifact_ref, source }) {
      const bytes = Buffer.from(source);
      return {
        sanitized_ref: {
          ...artifact_ref,
          artifact_class: 'raw',
          byte_length: bytes.byteLength,
          sha256: digestOf(bytes),
        },
        bytes,
        redaction_count: 0,
        sanitizer_version: 1,
        source_truncated: false,
        complete: true,
      };
    },
  };
  const rawClassBridge = makeBridge({ sanitizer: rawClassSanitizer }).bridge;
  const rawError = await errorOf(() => rawClassBridge.captureAssignmentArtifacts(captureInput({
    source: HOSTILE_SECRET,
  })));
  assert.equal(rawError.code, 'artifact_bridge_projection_denied');
  assertContentFree(rawError);

  const leakSanitizer = {
    async sanitize({ artifact_ref, source }) {
      const bytes = Buffer.from(source);
      return {
        sanitized_ref: {
          schema: ARTIFACT_REF_SCHEMA_ID,
          run_id: artifact_ref.run_id,
          assignment_id: artifact_ref.assignment_id,
          artifact_kind: artifact_ref.artifact_kind,
          artifact_class: 'sanitized',
          relative_path: artifact_ref.relative_path,
          byte_length: bytes.byteLength,
          sha256: digestOf(bytes),
          media_type: artifact_ref.media_type,
          content_encoding: 'identity',
        },
        bytes,
        redaction_count: 0,
        sanitizer_version: 1,
        source_truncated: false,
        complete: true,
      };
    },
  };
  const leakBridge = makeBridge({ sanitizer: leakSanitizer }).bridge;
  const leakError = await errorOf(() => leakBridge.captureAssignmentArtifacts(captureInput({
    source: `keep ${HOSTILE_SECRET}`,
  })));
  assert.equal(leakError.code, 'credential_leak_denied');
  assertContentFree(leakError);
});

test('project never accepts raw audience keys or oversized windows', async () => {
  const { bridge } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput());
  const audience = await errorOf(() => bridge.projectAssignmentArtifacts({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    audience: 'owner',
  }));
  assert.equal(audience.code, 'unknown_key');
  const oversized = await errorOf(() => bridge.projectAssignmentArtifacts(projectInput({
    max_bytes: 8193,
  })));
  assert.equal(oversized.code, 'out_of_range');
});

test('unknown artifact kind, empty source, and extra capture keys fail closed', async () => {
  const { bridge, rawStore } = makeBridge();
  const kind = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    artifact_kind: 'transcript',
  })));
  assert.equal(kind.code, 'unknown_artifact_kind');
  const empty = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    source: '',
  })));
  assert.equal(empty.code, 'out_of_range');
  const extra = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    candidate: 'refs/codex-co-engineer/runs/run-artifact-main/candidate',
  })));
  assert.equal(extra.code, 'unknown_key');
  assert.equal(rawStore.size(), 0);
  assertContentFree(kind);
  assertContentFree(empty);
  assertContentFree(extra);
});

test('store exceptions become content-free store failures', async () => {
  const inner = makeRawStore();
  const exploding = {
    ...inner,
    async publish() {
      throw new Error(`ENOENT ${HOSTILE_PATH} ${HOSTILE_SECRET}`);
    },
  };
  const { bridge } = makeBridge({ rawStore: exploding });
  const error = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput()));
  assert.equal(error.code, 'artifact_bridge_store_failed');
  assertContentFree(error);
});

function wrapGet(inner, mutate) {
  return {
    publish: inner.publish.bind(inner),
    list: inner.list.bind(inner),
    remove: inner.remove.bind(inner),
    async get(query) {
      const record = await inner.get(query);
      return mutate(record);
    },
  };
}

test('projection never upgrades truncation or completeness from a lying sanitizer', async () => {
  const upgrading = {
    async sanitize({ artifact_ref, source }) {
      const honest = await makeSanitizer().sanitize({
        artifact_ref,
        source,
        source_truncated: false,
      });
      return {
        ...honest,
        source_truncated: false,
        complete: true,
      };
    },
  };
  const rawStore = makeRawStore();
  const { bridge } = makeBridge({ rawStore, sanitizer: upgrading });
  const captured = await bridge.captureAssignmentArtifacts(captureInput({
    source_truncated: true,
  }));
  assert.equal(captured.source_truncated, true);
  assert.equal(captured.complete, false);
  const projection = await bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(projection.artifacts[0].source_truncated, true);
  assert.equal(projection.artifacts[0].complete, false);

  const restarted = makeBridge({ rawStore, sanitizer: upgrading });
  const again = await restarted.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(again.artifacts[0].source_truncated, true);
  assert.equal(again.artifacts[0].complete, false);
});

test('projection represents missing redaction, version, and completeness as unknown', async () => {
  const mute = {
    async sanitize({ artifact_ref, source }) {
      const honest = await makeSanitizer().sanitize({ artifact_ref, source });
      return {
        sanitized_ref: honest.sanitized_ref,
        bytes: honest.bytes,
      };
    },
  };
  const { bridge } = makeBridge({ sanitizer: mute });
  const captured = await bridge.captureAssignmentArtifacts(captureInput());
  assert.equal(captured.redaction_count, null);
  assert.equal(captured.sanitizer_version, null);
  const projection = await bridge.projectAssignmentArtifacts(projectInput());
  const artifact = projection.artifacts[0];
  assert.equal(artifact.redaction_count, null);
  assert.equal(artifact.sanitizer_version, null);
  assert.equal(artifact.complete, null);
  assert.notEqual(artifact.redaction_count, 0);
  assert.notEqual(artifact.sanitizer_version, 1);
  assert.notEqual(artifact.complete, true);
  assert.notEqual(artifact.complete, false);
});

test('capture readback fails closed on substituted, partial, mismatched, or stale bytes', async () => {
  const inner = makeRawStore();
  const swapped = wrapGet(inner, (record) => {
    if (record === null) return null;
    return {
      artifact_ref: record.artifact_ref,
      bytes: Buffer.alloc(record.bytes.byteLength, 0x78),
      source_truncated: record.source_truncated,
    };
  });
  const swappedBridge = makeBridge({ rawStore: swapped }).bridge;
  const swappedError = await errorOf(() => swappedBridge.captureAssignmentArtifacts(captureInput()));
  assert.equal(swappedError.code, 'artifact_bridge_store_failed');
  assertContentFree(swappedError);

  const partialInner = makeRawStore();
  const partial = wrapGet(partialInner, (record) => {
    if (record === null) return null;
    return {
      artifact_ref: record.artifact_ref,
      bytes: record.bytes.subarray(0, 4),
      source_truncated: record.source_truncated,
    };
  });
  const partialError = await errorOf(() => makeBridge({ rawStore: partial }).bridge
    .captureAssignmentArtifacts(captureInput()));
  assert.equal(partialError.code, 'artifact_bridge_store_failed');
  assertContentFree(partialError);

  const missingBytesInner = makeRawStore();
  const missingBytes = wrapGet(missingBytesInner, (record) => {
    if (record === null) return null;
    return { artifact_ref: record.artifact_ref };
  });
  const missingError = await errorOf(() => makeBridge({ rawStore: missingBytes }).bridge
    .captureAssignmentArtifacts(captureInput()));
  assert.equal(missingError.code, 'artifact_bridge_store_failed');
  assertContentFree(missingError);

  const staleInner = makeRawStore();
  const stale = wrapGet(staleInner, (record) => {
    if (record === null) return null;
    return {
      artifact_ref: {
        ...record.artifact_ref,
        relative_path: FOREIGN_RELATIVE,
      },
      bytes: record.bytes,
      source_truncated: record.source_truncated,
    };
  });
  const staleError = await errorOf(() => makeBridge({ rawStore: stale }).bridge
    .captureAssignmentArtifacts(captureInput()));
  assert.equal(staleError.code, 'artifact_bridge_store_failed');
  assertContentFree(staleError);

  const honest = makeBridge();
  await honest.bridge.captureAssignmentArtifacts(captureInput());
  const replayInner = honest.rawStore;
  const replayMissing = wrapGet(replayInner, (record) => {
    if (record === null) return null;
    return { artifact_ref: record.artifact_ref };
  });
  const replayError = await errorOf(() => makeBridge({ rawStore: replayMissing }).bridge
    .captureAssignmentArtifacts(captureInput()));
  assert.equal(replayError.code, 'artifact_bridge_store_failed');
  assertContentFree(replayError);
});
