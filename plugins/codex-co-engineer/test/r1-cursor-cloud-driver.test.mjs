// Runtime tests for the P21 Cursor Cloud SDK ProviderDriverV1 adapter:
// injected transport sequences for preflight identity, create/send
// confirmation, dispatch uncertainty, and no automatic PR creation.
// This is not live Cursor Cloud qualification.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURSOR_CLOUD_CAPABILITY_REVISION,
  CURSOR_CLOUD_DETAIL_CODES,
  CURSOR_CLOUD_DRIVER_SCHEMA_ID,
  CURSOR_CLOUD_PROVIDER_SLOT,
  CURSOR_CLOUD_TRANSPORT_OPERATIONS,
  assertCursorCloudTransportV1,
  bindCursorCloudDriverV1,
  createCursorCloudDriverV1,
  cursorCloudDriverDeclarationV1,
  describeCursorCloudDriverV1,
} from '../mcp/v3/cursor-cloud-driver.mjs';
import { childEnvelopeDigestV1 } from '../mcp/v3/identity.mjs';
import { compileChildEnvelopeV1 } from '../mcp/v3/prompt-compiler.mjs';
import {
  DRIVER_OPERATION_SCHEMA_IDS,
  PROVIDER_DRIVER_VERSION,
  assertCapabilityRequirementV1,
  assertProviderDriverV1,
  buildDriverOperationRequestV1,
} from '../mcp/v3/provider-driver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CLOUD_FIXTURE_AGENT_ID,
  CLOUD_FIXTURE_BRANCH,
  CLOUD_FIXTURE_MODEL,
  CLOUD_FIXTURE_PROVIDER_RUN_ID,
  CLOUD_FIXTURE_REPO_IDENTITY,
  CLOUD_FIXTURE_REPO_URL,
  LEAK_MARKER,
  buildCursorCloudDriverFixtureV1,
  createScriptedCursorCloudTransportV1,
  cursorCloudCallsOf,
} from './fixtures/r1-cursor-cloud-driver-fixtures.mjs';

const fixture = buildCursorCloudDriverFixtureV1();

function expectCode(fn, code, message) {
  assert.throws(fn, (error) => error instanceof RunContractV1Error && error.code === code, message);
}

function requestFor(operation, extras = {}, source = fixture) {
  return buildDriverOperationRequestV1(operation, source.envelope, extras);
}

function launchReady(transport = createScriptedCursorCloudTransportV1()) {
  const driver = bindCursorCloudDriverV1(transport);
  assert.equal(driver.preflight(requestFor('preflight')).disposition, 'ready');
  return { driver, transport };
}

function transportCounts(transport) {
  return {
    preflight: cursorCloudCallsOf(transport, 'preflight').length,
    create: cursorCloudCallsOf(transport, 'create').length,
    send: cursorCloudCallsOf(transport, 'send').length,
    observe: cursorCloudCallsOf(transport, 'observe').length,
    cancel: cursorCloudCallsOf(transport, 'cancel').length,
    reattach: cursorCloudCallsOf(transport, 'reattach').length,
  };
}

test('factory surface is closed, frozen, and hard-bound to cursor-cloud', () => {
  const transport = createScriptedCursorCloudTransportV1();
  const summary = assertCursorCloudTransportV1(transport);
  assert.equal(summary.schema, 'codex-co-engineer.cursor-cloud-transport.v1');
  assert.deepEqual([...summary.operations], [...CURSOR_CLOUD_TRANSPORT_OPERATIONS]);
  const driver = createCursorCloudDriverV1(transport);
  assertProviderDriverV1(driver);
  assert.deepEqual(Object.keys(driver).sort(), ['cancel', 'launch', 'preflight', 'reconcile']);
  assert.ok(Object.isFrozen(driver));
  const declaration = cursorCloudDriverDeclarationV1();
  assert.equal(declaration.capability.provider, CURSOR_CLOUD_PROVIDER_SLOT);
  assert.equal(declaration.capability.revision, CURSOR_CLOUD_CAPABILITY_REVISION);
});

test('the shipped declaration keeps asserting the honest Cursor Cloud posture', () => {
  const capability = assertCapabilityRequirementV1(cursorCloudDriverDeclarationV1(), {
    artifact_kinds: ['cloud_receipt', 'provider_report'],
    create_pr_posture: 'prohibited',
    dispatch_certainty: 'confirmed_launch',
    exact_model_selection: 'exact_and_attested',
    merge_authority: 'none_codex_only_integration',
    replay_posture: 'never_replay',
    same_session_reply: 'unsupported_unresolved_attention',
    workspace_semantics: 'remote_provider_managed',
    workspace_starting_point: 'pinned_pushed_sha',
  });
  assert.equal(capability.provider, 'cursor-cloud');
  assert.deepEqual({ ...cursorCloudDriverDeclarationV1().features }, {
    cancellation: 'supported',
    detailed_events: 'supported',
    live_progress: 'supported',
    restart: 'reconcile_reattach_only',
  });
});

test('describe reports bounded vocabularies and only false live claims', () => {
  const description = describeCursorCloudDriverV1();
  assert.equal(description.schema, CURSOR_CLOUD_DRIVER_SCHEMA_ID);
  assert.equal(description.provider, 'cursor-cloud');
  assert.equal(description.create_pr_posture, 'prohibited');
  assert.equal(description.live_qualification, false);
  for (const value of Object.values(description.claims)) assert.equal(value, false);
  assert.ok(CURSOR_CLOUD_DETAIL_CODES.length >= 16);
  assert.equal(new Set(CURSOR_CLOUD_DETAIL_CODES).size, CURSOR_CLOUD_DETAIL_CODES.length);
  assert.deepEqual([...description.forbidden ?? description.later_real_cursor_cloud_route.forbidden].sort(), [
    'cli_fallback_after_send', 'create_pr', 'digest_only_launch', 'merge_or_push',
    'post_intent_retry', 'provider_or_model_substitution', 'same_session_reply',
  ].sort());
});

test('preflight is ready on a clean pinned workspace with attested exact model', () => {
  const { driver, transport } = launchReady();
  const probe = cursorCloudCallsOf(transport, 'preflight')[0];
  assert.equal(probe.provider, 'cursor-cloud');
  assert.equal(probe.model, CLOUD_FIXTURE_MODEL);
  assert.equal(probe.starting_sha, fixture.base_sha);
  assert.equal(probe.run_id, fixture.run_id);
  assert.equal(probe.assignment_id, fixture.assignment_id);
  assert.equal(probe.child_envelope_digest, fixture.child_envelope_digest);
  assert.equal(driver.preflight(requestFor('preflight')).disposition, 'ready');
});

test('preflight blocks dirty, missing origin, invisible SHA, unattested model, and base advancement', () => {
  const cases = [
    [{ ok: false, detail_code: 'workspace_dirty' }, 'workspace_dirty'],
    [{ ok: false, detail_code: 'origin_missing' }, 'origin_missing'],
    [{ ok: false, detail_code: 'starting_ref_invisible' }, 'starting_ref_invisible'],
    [{ ok: false, detail_code: 'starting_ref_invalid' }, 'starting_ref_invalid'],
    [{ ok: false, detail_code: 'base_advanced' }, 'base_advanced'],
    [{ ok: false, detail_code: 'model_unattested' }, 'model_unattested'],
  ];
  for (const [receipt, code] of cases) {
    const transport = createScriptedCursorCloudTransportV1({
      preflight: [{
        ...receipt,
        provider: 'cursor-cloud',
        model: CLOUD_FIXTURE_MODEL,
        requested_model: CLOUD_FIXTURE_MODEL,
        effective_model: CLOUD_FIXTURE_MODEL,
        run_id: fixture.run_id,
        assignment_id: fixture.assignment_id,
        lane_index: fixture.lane_index,
        base_sha: fixture.base_sha,
        child_envelope_digest: fixture.child_envelope_digest,
        starting_sha: fixture.base_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
        repository_url: CLOUD_FIXTURE_REPO_URL,
        workspace_clean: code !== 'workspace_dirty',
        starting_ref_visible: code !== 'starting_ref_invisible',
        starting_ref_commit: code !== 'starting_ref_invalid',
        head_sha: fixture.base_sha,
        duplicate_identities: false,
        credential_bearing: false,
        auto_create_pr: false,
        detail_message: 'transport authored leak',
      }],
    });
    const driver = bindCursorCloudDriverV1(transport);
    const result = driver.preflight(requestFor('preflight'));
    assert.equal(result.disposition, 'blocked', code);
    assert.equal(result.detail_code, code);
    assert.doesNotMatch(result.detail_message, /leak/i);
    assert.doesNotMatch(result.detail_message, new RegExp(LEAK_MARKER, 'u'));
  }
});

test('preflight ready requires attested requested and effective model equality', () => {
  const transport = createScriptedCursorCloudTransportV1({
    preflight: [{
      ok: true,
      provider: 'cursor-cloud',
      model: CLOUD_FIXTURE_MODEL,
      requested_model: CLOUD_FIXTURE_MODEL,
      effective_model: 'gpt-5.1-codex',
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      starting_sha: fixture.base_sha,
      repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      repository_url: CLOUD_FIXTURE_REPO_URL,
      workspace_clean: true,
      starting_ref_visible: true,
      starting_ref_commit: true,
      head_sha: fixture.base_sha,
      duplicate_identities: false,
      credential_bearing: false,
      auto_create_pr: false,
    }],
  });
  const driver = bindCursorCloudDriverV1(transport);
  const result = driver.preflight(requestFor('preflight'));
  assert.equal(result.disposition, 'blocked');
  assert.equal(result.detail_code, 'model_unattested');
});

test('preflight rejects credential-bearing and duplicate identities without dispatch', () => {
  const credential = createScriptedCursorCloudTransportV1({
    preflight: [{
      ok: true,
      provider: 'cursor-cloud',
      model: CLOUD_FIXTURE_MODEL,
      requested_model: CLOUD_FIXTURE_MODEL,
      effective_model: CLOUD_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      starting_sha: fixture.base_sha,
      repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      repository_url: CLOUD_FIXTURE_REPO_URL,
      workspace_clean: true,
      starting_ref_visible: true,
      starting_ref_commit: true,
      head_sha: fixture.base_sha,
      duplicate_identities: false,
      credential_bearing: true,
      auto_create_pr: false,
    }],
  });
  expectCode(() => bindCursorCloudDriverV1(credential).preflight(requestFor('preflight')),
    'repository_credentials');
  assert.equal(transportCounts(credential).create, 0);

  const duplicate = createScriptedCursorCloudTransportV1({
    preflight: [{
      ok: true,
      provider: 'cursor-cloud',
      model: CLOUD_FIXTURE_MODEL,
      requested_model: CLOUD_FIXTURE_MODEL,
      effective_model: CLOUD_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      starting_sha: fixture.base_sha,
      repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
      repository_url: CLOUD_FIXTURE_REPO_URL,
      workspace_clean: true,
      starting_ref_visible: true,
      starting_ref_commit: true,
      head_sha: fixture.base_sha,
      duplicate_identities: true,
      credential_bearing: false,
      auto_create_pr: false,
    }],
  });
  expectCode(() => bindCursorCloudDriverV1(duplicate).preflight(requestFor('preflight')),
    'duplicate_identity');
  assert.equal(transportCounts(duplicate).create, 0);
});

test('launch dispatches only after authoritative agent, run, request, and branch identity', () => {
  const { driver, transport } = launchReady();
  const launched = driver.launch(requestFor('launch'));
  assert.equal(launched.disposition, 'dispatched');
  assert.equal(launched.detail_code, undefined);
  assert.equal(launched.run_id, fixture.run_id);
  assert.equal(launched.assignment_id, fixture.assignment_id);
  assert.equal(launched.lane_index, fixture.lane_index);
  assert.equal(launched.base_sha, fixture.base_sha);
  assert.equal(launched.child_envelope_digest, fixture.child_envelope_digest);
  const create = cursorCloudCallsOf(transport, 'create')[0];
  const send = cursorCloudCallsOf(transport, 'send')[0];
  assert.equal(create.auto_create_pr, false);
  assert.equal(create.provider, 'cursor-cloud');
  assert.equal(create.starting_sha, fixture.base_sha);
  assert.match(send.agent_id, /^bc-[0-9a-f]{32}$/u);
  assert.match(send.request_id, /^ccr-[0-9a-f]{32}$/u);
  assert.equal(send.envelope_text, fixture.envelope_text);
  assert.equal(send.auto_create_pr, false);
  assert.doesNotMatch(JSON.stringify(launched), new RegExp(LEAK_MARKER, 'u'));
});

test('create always sends auto_create_pr false and never authorizes a PR', () => {
  const { transport } = launchReady();
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  driver.launch(requestFor('launch'));
  for (const request of cursorCloudCallsOf(transport, 'create')) {
    assert.equal(request.auto_create_pr, false);
    assert.equal(Object.hasOwn(request, 'create_pr'), false);
  }
  expectCode(
    () => bindCursorCloudDriverV1(createScriptedCursorCloudTransportV1({
      preflight: [{
        ok: true,
        provider: 'cursor-cloud',
        model: CLOUD_FIXTURE_MODEL,
        requested_model: CLOUD_FIXTURE_MODEL,
        effective_model: CLOUD_FIXTURE_MODEL,
        run_id: fixture.run_id,
        assignment_id: fixture.assignment_id,
        lane_index: fixture.lane_index,
        base_sha: fixture.base_sha,
        child_envelope_digest: fixture.child_envelope_digest,
        starting_sha: fixture.base_sha,
        repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
        repository_url: CLOUD_FIXTURE_REPO_URL,
        workspace_clean: true,
        starting_ref_visible: true,
        starting_ref_commit: true,
        head_sha: fixture.base_sha,
        duplicate_identities: false,
        credential_bearing: false,
        auto_create_pr: true,
      }],
    })).preflight(requestFor('preflight')),
    'merge_authority_denied',
  );
});

test('create exception after intent is dispatch_uncertain and never replayed', () => {
  const transport = createScriptedCursorCloudTransportV1({
    create: [{ throw: true, code: 'transport_timeout', message: `timeout ${LEAK_MARKER}` }],
  });
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  const launched = driver.launch(requestFor('launch'));
  assert.equal(launched.disposition, 'dispatch_uncertain');
  assert.equal(launched.detail_code, undefined);
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
  assert.equal(transportCounts(transport).send, 0);
});

test('send acknowledgement failure after create is dispatch_uncertain', () => {
  const transport = createScriptedCursorCloudTransportV1({
    send: [{
      acknowledged: false,
      agent_id: CLOUD_FIXTURE_AGENT_ID,
      provider_run_id: CLOUD_FIXTURE_PROVIDER_RUN_ID,
      request_id: 'ccr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      branch: CLOUD_FIXTURE_BRANCH,
      provider: 'cursor-cloud',
      model: CLOUD_FIXTURE_MODEL,
      run_id: fixture.run_id,
      assignment_id: fixture.assignment_id,
      lane_index: fixture.lane_index,
      base_sha: fixture.base_sha,
      child_envelope_digest: fixture.child_envelope_digest,
      starting_sha: fixture.base_sha,
      repository_identity: CLOUD_FIXTURE_REPO_IDENTITY,
    }],
  });
  const driver = bindCursorCloudDriverV1(transport);
  driver.preflight(requestFor('preflight'));
  const launched = driver.launch(requestFor('launch'));
  assert.equal(launched.disposition, 'dispatch_uncertain');
  expectCode(() => driver.launch(requestFor('launch')), 'replay_denied');
});

test('cross-provider envelopes fail closed at the Cursor Cloud slot', () => {
  const grokManifest = {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'grok-not-cloud',
    repository: { path: '/opt/codex-co-engineer-cursor-cloud/suite', base_sha: fixture.base_sha },
    objective: 'Wrong provider.',
    assignments: [{
      assignment_id: 'grok-lane',
      role: 'implement',
      access: 'writer',
      prompt: 'Do not launch.',
      execution: { provider: 'grok', model: 'grok-4' },
      write_scope: ['mcp/**'],
      acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
      expected_duration_ms: 1_200_000,
      required_evidence: ['provider_report'],
    }],
    policy: {
      max_concurrency: 8,
      require_same_base: true,
      require_disjoint_writer_scopes: true,
      allow_post_dispatch_fallback: false,
      allow_merge: false,
      allow_create_pr: false,
      attention_mode: 'aggregate',
      completion_mode: 'all_settled_then_verify',
    },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
  const envelope = compileChildEnvelopeV1(grokManifest, 'grok-lane');
  const driver = bindCursorCloudDriverV1(createScriptedCursorCloudTransportV1());
  expectCode(() => driver.preflight({
    schema: DRIVER_OPERATION_SCHEMA_IDS.preflight,
    version: PROVIDER_DRIVER_VERSION,
    envelope_text: envelope.envelope_text,
    child_envelope_digest: childEnvelopeDigestV1(envelope).digest,
  }), 'provider_slot_mismatch');
});
