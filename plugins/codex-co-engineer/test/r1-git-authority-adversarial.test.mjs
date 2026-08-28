import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  GIT_AUTHORITY_SCHEMA_ID,
  GIT_AUTHORITY_VERSION,
  MAX_HISTORY_COMMITS,
  MAX_REF_BYTES,
  bindAuthorityIdentityV1,
  classifyGitOperationV1,
  classifyLaneHistoryV1,
  classifyRefV1,
  expectedLaneRefV1,
  projectAuthorityEvidenceV1,
} from '../mcp/v3/git-authority.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  ASSIGNMENT_ID,
  BASE_SHA,
  CONTENT_FREE,
  MANIFEST_DIGEST_HEX,
  RUN_ID,
  operationRequest,
  validIdentity,
} from './fixtures/r1-git-authority-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    assert.equal(utilTypes.isProxy(error), false);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function assertContentFree(value, extras = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('/tmp'), false);
  assert.equal(text.includes('https://'), false);
  for (const extra of extras) assert.equal(text.includes(extra), false, `leaked ${JSON.stringify(extra)}`);
  const message = typeof value === 'string' ? value : value?.message;
  if (typeof message === 'string') assert.match(message, CONTENT_FREE);
}

const laneRef = expectedLaneRefV1({
  run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
});

test('parent-failing hostile policy probes deny namespace escape without echoing attacker bytes', () => {
  const probes = [
    'refs/heads/codex/run-abababababababab/../main',
    'refs/heads/main.lock',
    'refs/heads/foo@{bar}',
    'refs/heads/codex/run-abababababababab/lane-alpha/',
    'refs/heads/\uFF4D\uFF41\uFF49\uFF4E',
    'refs/heads/\u0430lpha',
    'refs/heads/codex/run-abababababababab/\u200Blane-alpha',
    'refs/heads/codex/run-ABABABABABABABAB/lane-alpha',
    `refs/heads/${'a'.repeat(MAX_REF_BYTES)}`,
    'refs/heads/codex/run-abababababababab/LANE-ALPHA',
    'heads/main',
    'refs/heads/codex/run-ab/lane-alpha',
  ];
  for (const ref of probes) {
    const classified = classifyRefV1({ ref, identity: validIdentity(), manifest_digest_hex: MANIFEST_DIGEST_HEX });
    assert.equal(classified.protected, true, ref);
    assert.notEqual(classified.code, 'authority_ok', ref);
    assertContentFree(classified, [ref, '/tmp', 'https://']);
    const verdict = classifyGitOperationV1(operationRequest({
      operation: 'create_lane_branch',
      ref,
    }));
    assert.equal(verdict.verdict, 'denied');
    assertContentFree(verdict, [ref]);
    assertContentFree(verdict.message, [ref]);
  }
});

test('proxy accessor symbol and unknown-key inputs fail closed without running caller traps', () => {
  const { proxy, counts } = countingProxy(operationRequest({ ref: laneRef }));
  assert.equal(errorOf(() => classifyGitOperationV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const accessor = operationRequest({ ref: laneRef });
  Object.defineProperty(accessor, 'operation', {
    get() { throw new Error('accessor ran'); }, enumerable: true,
  });
  const accessorError = errorOf(() => classifyGitOperationV1(accessor));
  assert.ok(['accessor_property_denied', 'invalid_type'].includes(accessorError.code), accessorError.code);

  const symbolKeyed = operationRequest({ ref: laneRef });
  symbolKeyed[Symbol('push')] = true;
  assert.equal(errorOf(() => classifyGitOperationV1(symbolKeyed)).code, 'symbol_key_denied');

  const unknown = operationRequest({ ref: laneRef, extra: true });
  assert.equal(errorOf(() => classifyGitOperationV1(unknown)).code, 'unknown_key');
});

function assertPublicFailure(error, extras = []) {
  assert.ok(error instanceof RunContractV1Error);
  assert.equal(utilTypes.isProxy(error), false);
  assertContentFree(error, extras);
  assertContentFree(error.path, extras);
  assertContentFree(error.message, extras);
  assert.equal(String(error.path).includes('TypeError'), false);
  assert.equal(String(error.message).includes('TypeError'), false);
}

function assertRejectedEvidence(action, extras = []) {
  const error = errorOf(action);
  assertPublicFailure(error, extras);
  return error;
}

function trustedReceipt(overrides = {}) {
  return classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    history: { parent_counts: [1] },
    ...overrides,
  }));
}

function receiptLookalike(overrides = {}) {
  return {
    schema: GIT_AUTHORITY_SCHEMA_ID,
    version: GIT_AUTHORITY_VERSION,
    actor: 'worker',
    operation: 'commit_on_lane_branch',
    verdict: 'allowed',
    code: 'authority_ok',
    message: 'GitAuthorityPolicyV1 permits the requested git operation.',
    path: 'operation',
    ref_class: 'worker_lane',
    default_branch_target: false,
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    base_sha: BASE_SHA,
    ...overrides,
  };
}

test('forged missing wrong-schema wrong-identity and untrusted receipts cannot mint Git facts', () => {
  const minted = trustedReceipt();
  const cases = [
    [{}, ['forged empty']],
    [receiptLookalike(), ['caller constructed']],
    [Object.freeze(receiptLookalike()), ['frozen constructed']],
    [JSON.parse(JSON.stringify(minted)), ['json clone']],
    [{ ...minted }, ['spread clone']],
    [Object.freeze({ ...minted }), ['frozen clone']],
    [receiptLookalike({ schema: 'codex-co-engineer.provider-result.v1' }), ['wrong schema']],
    [receiptLookalike({ schema: GIT_AUTHORITY_SCHEMA_ID, version: 2 }), ['wrong version']],
  ];
  for (const [forged] of cases) {
    const error = assertRejectedEvidence(() => projectAuthorityEvidenceV1(forged));
    assert.notEqual(error.code, 'authority_ok');
  }

  const missing = receiptLookalike();
  delete missing.schema;
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(missing)).code, 'missing_key');

  const wrongIdentity = [
    { run_id: 'https://evil.example/steal?token=secret' },
    { assignment_id: '../main' },
    { base_sha: 'not-a-sha' },
    { run_id: `run-${'a'.repeat(1_000_000)}` },
    { assignment_id: `lane-${'\u0000'.repeat(32)}` },
    { base_sha: `${'a'.repeat(1_000_000)}` },
    { run_id: 'run-\u0430lpha-01' },
    { assignment_id: 'lane/alpha' },
    { base_sha: 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0' },
  ];
  for (const override of wrongIdentity) {
    const extras = Object.values(override).filter((value) => typeof value === 'string' && value.length < 200);
    const error = assertRejectedEvidence(
      () => projectAuthorityEvidenceV1(receiptLookalike(override)),
      extras,
    );
    assert.equal(error.code, 'authority_identity_invalid');
  }
});

test('provider report lookalikes and frozen caller receipts never become platform_git authority', () => {
  const minted = trustedReceipt();
  const providerLookalikes = [
    {
      schema: 'codex-co-engineer.provider-result.v1',
      provider: 'grok',
      model: 'grok-4',
      status: 'succeeded',
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      base_sha: BASE_SHA,
      verdict: 'allowed',
      code: 'authority_ok',
      message: minted.message,
      actor: 'worker',
      operation: 'commit_on_lane_branch',
      path: 'operation',
      ref_class: 'worker_lane',
      default_branch_target: false,
      version: GIT_AUTHORITY_VERSION,
    },
    {
      schema: GIT_AUTHORITY_SCHEMA_ID,
      version: GIT_AUTHORITY_VERSION,
      provider: 'cursor-cloud',
      create_pr: true,
      verdict: 'allowed',
      code: 'authority_ok',
      run_id: RUN_ID,
      assignment_id: ASSIGNMENT_ID,
      base_sha: BASE_SHA,
    },
  ];
  for (const lookalike of providerLookalikes) {
    const extras = ['grok-4', 'cursor-cloud', 'create_pr', 'provider-result'];
    const error = assertRejectedEvidence(() => projectAuthorityEvidenceV1(lookalike), extras);
    assert.ok(error.code === 'unknown_key' || error.code === 'missing_key' || error.code === 'invalid_type'
      || error.code === 'invalid_format', error.code);
  }
  const frozenCaller = Object.freeze({ ...minted });
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(frozenCaller)).code, 'invalid_type');
});

test('hostile oversized control Unicode path URL and credential identity values never emit', () => {
  const hostile = [
    { run_id: 'https://attacker.example/hook' },
    { run_id: '/tmp/cce-r1-authority-repo' },
    { run_id: 'git@github.com:evil/repo.git' },
    { assignment_id: 'Bearer abc' },
    { assignment_id: 'secret-token' },
    { base_sha: 'https://example.invalid/repo.git' },
    { run_id: `run-${'\u0007'.repeat(8)}` },
    { assignment_id: 'lane-\u200Balpha' },
    { run_id: 'run-\uFF41lpha-01' },
  ];
  for (const override of hostile) {
    const extras = [...Object.values(override), '/tmp', 'https://', 'secret-token', 'Bearer'];
    const error = assertRejectedEvidence(
      () => projectAuthorityEvidenceV1(receiptLookalike(override)),
      extras.filter((value) => typeof value === 'string' && value.length > 0 && value.length < 200),
    );
    assert.ok(
      error.code === 'authority_identity_invalid' || error.code === 'invalid_type',
      error.code,
    );
  }
});

test('evidence context rejects null primitives functions accessors proxies extras and exotic shapes', () => {
  const minted = trustedReceipt();
  const live = countingProxy({ fact_id: 'f-ok' });
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, live.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(live.counts), 0);

  const revoked = Proxy.revocable({ fact_id: 'f-ok' }, {
    get() { throw new Error('revoked getter ran'); },
    ownKeys() { throw new Error('revoked ownKeys ran'); },
  });
  revoked.revoke();
  const revokedError = assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, revoked.proxy));
  assert.equal(revokedError.code, 'proxy_denied');

  const accessor = {};
  Object.defineProperty(accessor, 'fact_id', {
    get() { throw new Error('accessor ran'); }, enumerable: true,
  });
  const accessorError = assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, accessor));
  assert.ok(['accessor_property_denied', 'invalid_type'].includes(accessorError.code), accessorError.code);

  const hidden = { fact_id: 'f-ok' };
  Object.defineProperty(hidden, 'secret', { value: 'https://evil.example', enumerable: false });
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, hidden), ['secret', 'https://evil.example']).code, 'unknown_key');

  const symbolKeyed = { fact_id: 'f-ok' };
  symbolKeyed[Symbol('push')] = true;
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, symbolKeyed)).code, 'symbol_key_denied');

  const exotic = Object.assign(Object.create({ stolen: 'https://evil.example' }), { fact_id: 'f-ok' });
  const exoticError = assertRejectedEvidence(
    () => projectAuthorityEvidenceV1(minted, exotic),
    ['stolen', 'https://evil.example'],
  );
  assert.ok(['exotic_prototype_denied', 'invalid_type'].includes(exoticError.code), exoticError.code);

  const primitives = [null, 0, 1, false, true, '', 'https://evil.example', 1n, Symbol('ctx')];
  for (const context of primitives) {
    const extras = typeof context === 'string' && context.length > 0 ? [context] : [];
    assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, context), extras).code, 'invalid_type');
  }
  assert.equal(assertRejectedEvidence(() => projectAuthorityEvidenceV1(minted, () => 'https://evil.example')).code, 'invalid_type');
  const extraKey = { fact_id: 'f-ok', 'https://evil.example/x': true };
  const extraError = assertRejectedEvidence(
    () => projectAuthorityEvidenceV1(minted, extraKey),
    ['https://evil.example/x'],
  );
  assert.equal(extraError.code, 'unknown_key');
});

test('unknown-key public failures redact attacker keys values paths URLs and credentials', () => {
  const attackerKey = 'https://evil.example/steal?token=secret-token#/tmp/repo';
  const unknown = operationRequest({ ref: laneRef, [attackerKey]: true });
  const error = errorOf(() => classifyGitOperationV1(unknown));
  assert.equal(error.code, 'unknown_key');
  assertPublicFailure(error, [attackerKey, 'secret-token', 'https://', '/tmp/repo', 'evil.example']);
  assert.equal(error.path.includes(attackerKey), false);
  assert.equal(error.message.includes(attackerKey), false);

  const minted = trustedReceipt();
  const evidenceError = assertRejectedEvidence(
    () => projectAuthorityEvidenceV1(minted, { [attackerKey]: 1 }),
    [attackerKey, 'secret-token'],
  );
  assert.equal(evidenceError.code, 'unknown_key');
  assert.equal(evidenceError.path.includes(attackerKey), false);
});

test('trusted policy receipts keep immutable deny-lane decisions and content-free P13 facts', () => {
  const allowed = trustedReceipt();
  const allowedEvidence = projectAuthorityEvidenceV1(allowed, {
    fact_id: 'f-lane', discrepancy_id: 'd-lane', sequence: 4,
  });
  assert.equal(allowedEvidence.facts[0].status, 'verified');
  assert.equal(allowedEvidence.facts[0].authority, 'platform_git');
  assert.equal(allowedEvidence.facts[0].run_id, RUN_ID);
  assert.equal(allowedEvidence.facts[0].assignment_id, ASSIGNMENT_ID);
  assert.equal(allowedEvidence.facts[0].payload.base_sha, BASE_SHA);
  assert.equal(allowedEvidence.discrepancies.length, 0);
  assertContentFree(allowedEvidence);

  const denied = classifyGitOperationV1(operationRequest({ operation: 'push' }));
  assert.equal(denied.verdict, 'denied');
  assert.equal(denied.code, 'push_authority_denied');
  const deniedEvidence = projectAuthorityEvidenceV1(denied);
  assert.equal(deniedEvidence.facts[0].status, 'failed');
  assert.equal(deniedEvidence.discrepancies[0].code, 'security_boundary');
  assertContentFree(deniedEvidence);

  const protectedTarget = classifyGitOperationV1(operationRequest({
    operation: 'create_lane_branch',
    ref: 'refs/heads/main',
    default_branch: 'main',
  }));
  assert.equal(protectedTarget.code, 'default_branch_target_denied');
  const protectedEvidence = projectAuthorityEvidenceV1(protectedTarget);
  assert.equal(protectedEvidence.facts[0].method, 'protected_ref_snapshot_compare');
  assertContentFree(protectedEvidence);
});

test('credential URL and remote-mutation material cannot bind as identity', () => {
  const cases = [
    { token: 'secret-token' },
    { authorization: 'Bearer abc' },
    { credentials: { password: 'x' } },
    { push_url: 'https://example.invalid/repo.git' },
  ];
  for (const extra of cases) {
    const error = errorOf(() => bindAuthorityIdentityV1(validIdentity(extra)));
    assert.ok(
      error.code === 'credential_content_denied' || error.code === 'unknown_key' || error.code === 'merge_authority_denied',
      extra,
    );
    assertContentFree(error.message);
  }
  const urlPath = errorOf(() => bindAuthorityIdentityV1(validIdentity({
    repository_path: 'https://example.invalid/repo.git',
  })));
  assert.equal(urlPath.code, 'authority_identity_invalid');
  assert.equal(urlPath.message.includes('https://'), false);
});

test('unknown operations capability lies and actor mismatches fail closed', () => {
  assert.equal(errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'squash',
  }))).code, 'unknown_git_operation');

  const posture = errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'commit_on_lane_branch',
    ref: laneRef,
    capability: {
      merge_authority: 'provider_may_merge',
      create_pr_posture: 'prohibited',
    },
  })));
  assert.equal(posture.code, 'authority_posture_mismatch');

  const cloudLocal = errorOf(() => classifyGitOperationV1(operationRequest({
    operation: 'read_only_inspect',
    capability: {
      merge_authority: 'none_codex_only_integration',
      create_pr_posture: 'non_authoritative_cloud_only',
      provider: 'grok',
    },
  })));
  assert.equal(cloudLocal.code, 'authority_posture_mismatch');

  const platformCommit = classifyGitOperationV1(operationRequest({
    actor: 'platform',
    operation: 'commit_on_lane_branch',
    ref: laneRef,
  }));
  assert.equal(platformCommit.code, 'authority_posture_mismatch');
});

test('bounds abuse of history arrays refs and keys is rejected', () => {
  const hugeHistory = classifyLaneHistoryV1;
  const tooMany = Array.from({ length: MAX_HISTORY_COMMITS + 1 }, () => 1);
  assert.equal(errorOf(() => hugeHistory({ parent_counts: tooMany })).code, 'out_of_range');
  assert.equal(errorOf(() => hugeHistory({ parent_counts: [99] })).code, 'out_of_range');
  assert.equal(errorOf(() => hugeHistory({ parent_counts: [] })).code, 'out_of_range');

  const longRef = `refs/heads/${'a'.repeat(MAX_REF_BYTES)}`;
  const classified = classifyRefV1({ ref: longRef });
  assert.equal(classified.code, 'branch_namespace_violation');
  assertContentFree(classified, [longRef]);

  const bulky = operationRequest({ ref: laneRef });
  for (let i = 0; i < 40; i += 1) bulky[`k${i}`] = i;
  assert.equal(errorOf(() => classifyGitOperationV1(bulky)).code, 'out_of_range');
});

test('publisher and Sol publication probes fail closed without force tag release or protected writes', () => {
  const owned = expectedLaneRefV1({
    run_id: RUN_ID, assignment_id: ASSIGNMENT_ID, manifest_digest_hex: MANIFEST_DIGEST_HEX,
  });
  const publication = {
    user_authorized_publication: true,
    draft: true,
    force: false,
    expected_head: BASE_SHA,
    current_head: BASE_SHA,
    current_tree: BASE_SHA,
    candidate_tree: BASE_SHA,
    ci_green: true,
    ci_current: true,
    failed_check_count: 0,
    hidden_failed_checks: false,
    verifier_accepted: true,
    merge_topology_ok: true,
  };

  const otherLane = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'push',
    ref: 'refs/heads/codex/run-aaaaaaaaaaaaaaaa/lane-beta',
    publication,
  }));
  assert.equal(otherLane.verdict, 'denied');
  assertContentFree(otherLane);

  const main = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'push',
    ref: 'refs/heads/main',
    publication,
  }));
  assert.equal(main.code, 'default_branch_target_denied');

  const nonDraft = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'create_pr',
    ref: owned,
    publication: { ...publication, draft: false },
  }));
  assert.equal(nonDraft.code, 'non_draft_pr_denied');

  const force = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'push',
    ref: owned,
    publication: { ...publication, force: true },
  }));
  assert.equal(force.code, 'push_authority_denied');

  const forcePush = classifyGitOperationV1(operationRequest({
    actor: 'publisher',
    operation: 'force_push',
    ref: owned,
    publication,
  }));
  assert.equal(forcePush.code, 'push_authority_denied');

  const tag = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'tag_create',
    ref: owned,
    publication,
  }));
  assert.equal(tag.code, 'protected_ref_write_denied');
  const release = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'release_create',
    ref: owned,
    publication,
  }));
  assert.equal(release.code, 'protected_ref_write_denied');

  const changedHead = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'merge_pr',
    ref: owned,
    identity: validIdentity({ head_sha: BASE_SHA }),
    publication: { ...publication, current_head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  }));
  assert.equal(changedHead.code, 'expected_head_mismatch');

  const staleCi = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'merge_pr',
    ref: owned,
    identity: validIdentity({ head_sha: BASE_SHA }),
    publication: { ...publication, ci_current: false },
  }));
  assert.equal(staleCi.code, 'stale_ci');

  const failed = classifyGitOperationV1(operationRequest({
    actor: 'sol',
    operation: 'merge_pr',
    ref: owned,
    identity: validIdentity({ head_sha: BASE_SHA }),
    publication: { ...publication, failed_check_count: 2, ci_green: false },
  }));
  assert.equal(failed.code, 'failed_checks_present');

  const workerMerge = classifyGitOperationV1(operationRequest({
    actor: 'worker',
    operation: 'merge_pr',
    ref: owned,
    publication,
  }));
  assert.equal(workerMerge.code, 'merge_authority_denied');
});

test('policy customization and evidence projection stay closed and content-free', () => {
  const evidence = projectAuthorityEvidenceV1(classifyGitOperationV1(operationRequest({
    operation: 'push',
  })), { fact_id: 'f-push', discrepancy_id: 'd-push', sequence: 3 });
  assert.equal(evidence.facts[0].fact_id, 'f-push');
  assert.equal(evidence.discrepancies[0].code, 'security_boundary');
  assertContentFree(evidence, ['refs/heads', 'https://', 'secret']);
  assert.equal(errorOf(() => projectAuthorityEvidenceV1(classifyGitOperationV1(operationRequest({
    operation: 'push',
  })), { fact_id: 'F-PUSH' })).code, 'invalid_format');
});
