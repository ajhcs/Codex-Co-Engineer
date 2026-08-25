// P33 run artifact bridge focused coverage: identity-bound owner-only raw
// capture, bounded sanitized projection, restart truthfulness, and
// proof-bound per-run cleanup.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_CLASSES,
  ARTIFACT_KINDS,
} from '../mcp/v3/artifact-ref.mjs';
import {
  CAPTURE_RECEIPT_KEYS,
  CLEANUP_RECEIPT_KEYS,
  MAX_PROJECTION_BYTES,
  PROJECTION_ARTIFACT_KEYS,
  PROJECTION_RECEIPT_KEYS,
  RUN_ARTIFACT_BRIDGE_CAPTURE_SCHEMA_ID,
  RUN_ARTIFACT_BRIDGE_CLEANUP_SCHEMA_ID,
  RUN_ARTIFACT_BRIDGE_FACTORY_KEYS,
  RUN_ARTIFACT_BRIDGE_METHODS,
  RUN_ARTIFACT_BRIDGE_PROJECTION_SCHEMA_ID,
  RUN_ARTIFACT_BRIDGE_SCHEMA_ID,
  RUN_ARTIFACT_BRIDGE_VERSION,
  createRunArtifactBridge,
  describeRunArtifactBridgeV1,
} from '../mcp/v3/run-artifact-bridge.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  ASSIGNMENT_A,
  ASSIGNMENT_B,
  CLOCK_START,
  HOSTILE_PATH,
  HOSTILE_SECRET,
  PLAIN_TEXT,
  REDACTED,
  RELATIVE_A,
  RELATIVE_B,
  RUN_ID,
  SECRET_TEXT,
  captureInput,
  digestOf,
  cleanupInput,
  decodeSelected,
  makeBridge,
  makeClock,
  makeEvidenceBundle,
  makeRawStore,
  makeSanitizer,
  projectInput,
} from './fixtures/r1-run-artifact-bridge-fixtures.mjs';

const MODULE_PATH = fileURLToPath(new URL('../mcp/v3/run-artifact-bridge.mjs', import.meta.url));

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertFrozenTree(value) {
  assert.ok(value === null || typeof value !== 'object' || Object.isFrozen(value),
    'returned records must be frozen');
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) assertFrozenTree(child);
  }
}

function assertNoSecret(text, extras = []) {
  assert.doesNotMatch(text, /sk-live/u);
  assert.doesNotMatch(text, /ATTACKER-SECRET/u);
  assert.doesNotMatch(text, /github_pat/u);
  for (const extra of extras) {
    assert.equal(text.includes(extra), false, 'must not leak extra secret material');
  }
}

test('createRunArtifactBridge is the frozen v1 factory with exact methods', () => {
  assert.equal(RUN_ARTIFACT_BRIDGE_SCHEMA_ID, 'codex-co-engineer.run-artifact-bridge.v1');
  assert.equal(RUN_ARTIFACT_BRIDGE_VERSION, 1);
  assert.deepEqual([...RUN_ARTIFACT_BRIDGE_FACTORY_KEYS], [
    'rawStore', 'sanitizer', 'evidenceBundle', 'clock',
  ]);
  assert.deepEqual([...RUN_ARTIFACT_BRIDGE_METHODS], [
    'captureAssignmentArtifacts',
    'projectAssignmentArtifacts',
    'cleanupRunArtifacts',
  ]);
  const { bridge } = makeBridge();
  assert.deepEqual(Object.keys(bridge), [...RUN_ARTIFACT_BRIDGE_METHODS]);
  assert.equal(Object.isFrozen(bridge), true);
  const inventory = describeRunArtifactBridgeV1();
  assert.equal(inventory.raw_owner_only, true);
  assert.equal(inventory.model_facing_sanitized_only, true);
  assert.equal(inventory.proof_bound_cleanup, true);
  assert.equal(inventory.automatic_gc, false);
  assert.equal(inventory.remote_mutated, false);
  assert.equal(inventory.imports_runtime, false);
  assert.equal(inventory.imports_scheduler, false);
  assert.equal(inventory.imports_lifecycle, false);
  assert.equal(inventory.imports_server, false);
  assert.equal(inventory.imports_candidate, false);
  assert.deepEqual(inventory.artifact_classes, [...ARTIFACT_CLASSES]);
  assert.deepEqual(inventory.artifact_kinds, [...ARTIFACT_KINDS]);
  assert.equal(inventory.max_projection_bytes, MAX_PROJECTION_BYTES);
});

test('P33 source does not import runtime, scheduler, lifecycle, server, or candidate paths', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  for (const forbidden of [
    'run-runtime.mjs',
    'run-scheduler.mjs',
    'run-journal.mjs',
    'acp-worker.mjs',
    'process-boundary.mjs',
    'supervisor.mjs',
    'server.mjs',
    'mailbox.mjs',
    'artifact-store.mjs',
    'artifact-sanitizer.mjs',
    'artifact-reader.mjs',
    'evidence-bundle.mjs',
    'run-candidate-composer.mjs',
    'run-combined-verifier.mjs',
  ]) {
    assert.equal(source.includes(`from './${forbidden}'`), false, forbidden);
  }
});

test('capture publishes owner-only raw evidence and a sanitized projection receipt', async () => {
  const { bridge, rawStore, evidenceBundle } = makeBridge();
  const receipt = await bridge.captureAssignmentArtifacts(captureInput());
  assertFrozenTree(receipt);
  assert.deepEqual(Object.keys(receipt).sort(), [...CAPTURE_RECEIPT_KEYS].sort());
  assert.equal(receipt.schema, RUN_ARTIFACT_BRIDGE_CAPTURE_SCHEMA_ID);
  assert.equal(receipt.run_id, RUN_ID);
  assert.equal(receipt.assignment_id, ASSIGNMENT_A);
  assert.equal(receipt.created, true);
  assert.equal(receipt.captured_at, CLOCK_START);
  assert.equal(receipt.raw_ref.artifact_class, 'raw');
  assert.equal(receipt.sanitized_ref.artifact_class, 'sanitized');
  assert.equal(receipt.raw_ref.relative_path, RELATIVE_A);
  assert.equal(receipt.sanitized_ref.relative_path, RELATIVE_A);
  assert.equal(Object.hasOwn(receipt, 'bytes'), false);
  assert.equal(JSON.stringify(receipt).includes(PLAIN_TEXT), false);
  const stored = await rawStore.get({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    relative_path: RELATIVE_A,
  });
  assert.equal(stored.artifact_ref.artifact_class, 'raw');
  assert.equal(Buffer.from(stored.bytes).toString('utf8'), PLAIN_TEXT);
  assert.equal(evidenceBundle.events[0].code, 'captured');
  assert.equal(evidenceBundle.events[0].kind, 'capture');
});

test('project returns only bounded sanitized artifacts and never raw bytes', async () => {
  const { bridge } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput({ source: SECRET_TEXT }));
  const projection = await bridge.projectAssignmentArtifacts(projectInput());
  assertFrozenTree(projection);
  assert.deepEqual(Object.keys(projection).sort(), [...PROJECTION_RECEIPT_KEYS].sort());
  assert.equal(projection.schema, RUN_ARTIFACT_BRIDGE_PROJECTION_SCHEMA_ID);
  assert.equal(projection.artifacts.length, 1);
  const artifact = projection.artifacts[0];
  assert.deepEqual(Object.keys(artifact).sort(), [...PROJECTION_ARTIFACT_KEYS].sort());
  assert.equal(artifact.sanitized_ref.artifact_class, 'sanitized');
  assert.equal(Object.hasOwn(artifact, 'raw_ref'), false);
  const text = decodeSelected(artifact);
  assert.equal(text.includes(REDACTED), true);
  assert.equal(artifact.redaction_count > 0, true);
  assertNoSecret(text);
  assertNoSecret(JSON.stringify(projection), [HOSTILE_SECRET, HOSTILE_PATH]);
});

test('identical capture replay is restart-truthful and does not duplicate raw storage', async () => {
  const rawStore = makeRawStore();
  const evidenceBundle = makeEvidenceBundle();
  const first = makeBridge({ rawStore, evidenceBundle, clock: makeClock() });
  const created = await first.bridge.captureAssignmentArtifacts(captureInput());
  assert.equal(created.created, true);
  assert.equal(rawStore.size(), 1);

  const restarted = makeBridge({
    rawStore,
    evidenceBundle,
    sanitizer: makeSanitizer(),
    clock: makeClock('2026-08-25T22:05:00Z'),
  });
  const replay = await restarted.bridge.captureAssignmentArtifacts(captureInput());
  assert.equal(replay.created, false);
  assert.equal(replay.raw_ref.sha256, created.raw_ref.sha256);
  assert.equal(rawStore.size(), 1);
  const projection = await restarted.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(projection.artifacts.length, 1);
  assert.equal(decodeSelected(projection.artifacts[0]), PLAIN_TEXT);
  assert.equal(evidenceBundle.events.some((event) => event.code === 'replayed'), true);
});

test('a different payload at the same identity fails closed without replacing bytes', async () => {
  const { bridge, rawStore } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput());
  const error = await errorOf(() => bridge.captureAssignmentArtifacts(captureInput({
    source: 'different payload',
  })));
  assert.equal(error.code, 'artifact_bridge_restart_conflict');
  const stored = await rawStore.get({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    relative_path: RELATIVE_A,
  });
  assert.equal(Buffer.from(stored.bytes).toString('utf8'), PLAIN_TEXT);
});

test('projection after restart re-sanitizes owner raw rather than inventing artifacts', async () => {
  const rawStore = makeRawStore();
  const first = makeBridge({ rawStore });
  await first.bridge.captureAssignmentArtifacts(captureInput({ source: SECRET_TEXT }));
  const restarted = makeBridge({ rawStore, sanitizer: makeSanitizer() });
  const projection = await restarted.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(projection.artifacts.length, 1);
  assertNoSecret(decodeSelected(projection.artifacts[0]));
});

test('cleanup with matching run proof removes only that run and is idempotent', async () => {
  const { bridge, rawStore } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput());
  await bridge.captureAssignmentArtifacts(captureInput({
    assignment_id: ASSIGNMENT_B,
    artifact_kind: 'git_diff',
    relative_path: RELATIVE_B,
    source: 'diff --git a/x b/x',
  }));
  assert.equal(rawStore.size(), 2);
  const cleaned = await bridge.cleanupRunArtifacts(cleanupInput({
    proof: { run_id: RUN_ID },
  }));
  assertFrozenTree(cleaned);
  assert.deepEqual(Object.keys(cleaned).sort(), [...CLEANUP_RECEIPT_KEYS].sort());
  assert.equal(cleaned.schema, RUN_ARTIFACT_BRIDGE_CLEANUP_SCHEMA_ID);
  assert.equal(cleaned.cleaned, true);
  assert.equal(cleaned.removed, 2);
  assert.equal(cleaned.remaining, 0);
  assert.equal(rawStore.size(), 0);
  const replay = await bridge.cleanupRunArtifacts(cleanupInput({
    proof: { run_id: RUN_ID },
  }));
  assert.equal(replay.cleaned, true);
  assert.equal(replay.removed, 0);
  const empty = await bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(empty.artifacts.length, 0);
});

test('assignment-scoped proof cannot escape the run or sibling assignments', async () => {
  const { bridge, rawStore } = makeBridge();
  await bridge.captureAssignmentArtifacts(captureInput());
  await bridge.captureAssignmentArtifacts(captureInput({
    assignment_id: ASSIGNMENT_B,
    artifact_kind: 'git_diff',
    relative_path: RELATIVE_B,
    source: 'diff --git a/x b/x',
  }));
  const cleaned = await bridge.cleanupRunArtifacts(cleanupInput({
    proof: { run_id: RUN_ID, assignment_ids: [ASSIGNMENT_A] },
  }));
  assert.equal(cleaned.cleaned, true);
  assert.equal(cleaned.removed, 1);
  assert.equal(cleaned.remaining, 1);
  const leftover = await rawStore.list({ run_id: RUN_ID });
  assert.equal(leftover.length, 1);
  assert.equal(leftover[0].artifact_ref.assignment_id, ASSIGNMENT_B);
});

test('clock stamps capture, projection, and cleanup', async () => {
  const clock = makeClock('2026-08-25T22:10:00Z');
  const { bridge } = makeBridge({ clock });
  const captured = await bridge.captureAssignmentArtifacts(captureInput());
  assert.equal(captured.captured_at, '2026-08-25T22:10:00Z');
  clock.set('2026-08-25T22:11:00Z');
  const projected = await bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(projected.projected_at, '2026-08-25T22:11:00Z');
  clock.set('2026-08-25T22:12:00Z');
  const cleaned = await bridge.cleanupRunArtifacts(cleanupInput());
  assert.equal(cleaned.cleaned_at, '2026-08-25T22:12:00Z');
});

test('bounded projection clips selected bytes and reports paging facts', async () => {
  const { bridge } = makeBridge();
  const source = 'abcdefghij'.repeat(100);
  await bridge.captureAssignmentArtifacts(captureInput({ source }));
  const page = await bridge.projectAssignmentArtifacts(projectInput({
    offset: 0,
    max_bytes: 16,
  }));
  assert.equal(page.artifacts[0].selected_byte_length, 16);
  assert.equal(page.artifacts[0].more, true);
  assert.equal(page.artifacts[0].next_offset, 16);
  assert.equal(page.artifacts[0].reader_clipped, true);
  const rest = await bridge.projectAssignmentArtifacts(projectInput({
    offset: 16,
    max_bytes: 16,
  }));
  assert.equal(decodeSelected(page.artifacts[0]) + decodeSelected(rest.artifacts[0]),
    source.slice(0, 32));
});

test('complete, redacted, and versioned capture readback bind stored bytes', async () => {
  const { bridge, rawStore } = makeBridge({
    sanitizer: makeSanitizer({ sanitizerVersion: 7 }),
  });
  const complete = await bridge.captureAssignmentArtifacts(captureInput());
  assert.equal(complete.source_truncated, false);
  assert.equal(complete.complete, true);
  assert.equal(complete.redaction_count, 0);
  assert.equal(complete.sanitizer_version, 7);
  const storedComplete = await rawStore.get({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    relative_path: RELATIVE_A,
  });
  assert.equal(digestOf(storedComplete.bytes), complete.raw_ref.sha256);
  assert.equal(Buffer.from(storedComplete.bytes).byteLength, complete.raw_ref.byte_length);
  const completeProjection = await bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(completeProjection.artifacts[0].complete, true);
  assert.equal(completeProjection.artifacts[0].source_truncated, false);
  assert.equal(completeProjection.artifacts[0].redaction_count, 0);
  assert.equal(completeProjection.artifacts[0].sanitizer_version, 7);

  const redactedBridge = makeBridge({
    sanitizer: makeSanitizer({ sanitizerVersion: 7 }),
  });
  const redacted = await redactedBridge.bridge.captureAssignmentArtifacts(captureInput({
    source: SECRET_TEXT,
  }));
  assert.equal(redacted.redaction_count > 0, true);
  assert.equal(redacted.sanitizer_version, 7);
  assert.equal(redacted.complete, true);
  const storedRedacted = await redactedBridge.rawStore.get({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    relative_path: RELATIVE_A,
  });
  assert.equal(digestOf(storedRedacted.bytes), redacted.raw_ref.sha256);
  const redactedProjection = await redactedBridge.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(redactedProjection.artifacts[0].redaction_count, redacted.redaction_count);
  assert.equal(redactedProjection.artifacts[0].sanitizer_version, 7);
  assert.equal(decodeSelected(redactedProjection.artifacts[0]).includes(REDACTED), true);
});

test('truncated capture stays incomplete across projection and restart', async () => {
  const rawStore = makeRawStore();
  const first = makeBridge({ rawStore });
  const captured = await first.bridge.captureAssignmentArtifacts(captureInput({
    source_truncated: true,
  }));
  assert.equal(captured.source_truncated, true);
  assert.equal(captured.complete, false);
  const projected = await first.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(projected.artifacts[0].source_truncated, true);
  assert.equal(projected.artifacts[0].complete, false);

  const restarted = makeBridge({ rawStore, sanitizer: makeSanitizer() });
  const again = await restarted.bridge.projectAssignmentArtifacts(projectInput());
  assert.equal(again.artifacts[0].source_truncated, true);
  assert.equal(again.artifacts[0].complete, false);
});

test('factory rejects missing injected seams', () => {
  assert.throws(() => createRunArtifactBridge({}), (error) => {
    assert.ok(error instanceof RunContractV1Error);
    assert.equal(error.code, 'missing_key');
    return true;
  });
});
