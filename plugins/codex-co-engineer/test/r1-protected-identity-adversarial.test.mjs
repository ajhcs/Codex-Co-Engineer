import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  buildGitIdentityV1,
  buildProviderRunIdentityV1,
  buildRunIdentityV1,
  buildWorkspaceIdentityV1,
  validateGitIdentityV1,
} from '../mcp/v3/protected-identity.mjs';
import {
  BASE_SHA,
  REPOSITORY_PATH,
  RUN_ID,
  ASSIGNMENT_ID,
  fixtureCapabilityDigest,
  fixtureEnvelopeDigest,
  fixtureGit,
  fixtureLaneDigest,
  fixtureManifestDigest,
} from './fixtures/r1-protected-identity-fixtures.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

function gitInput() {
  return { repository_path: REPOSITORY_PATH, base_sha: BASE_SHA };
}

test('live and revoked Proxies fail closed with zero trap dispatch', () => {
  const { proxy, counts } = countingProxy(gitInput());
  assert.equal(errorOf(() => buildGitIdentityV1(proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(counts), 0);

  const target = gitInput();
  const { proxy: revoked, revoke } = Proxy.revocable(target, {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(revoked), true);
  assert.equal(errorOf(() => buildGitIdentityV1(revoked)).code, 'proxy_denied');
  assert.throws(() => Array.isArray(revoked), TypeError);
  assert.throws(() => Reflect.ownKeys(revoked), TypeError);
});

test('accessor, symbol, exotic, sparse, alias, and cycle inputs fail closed', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'repository_path', {
    enumerable: true,
    get() { return REPOSITORY_PATH; },
  });
  accessor.base_sha = BASE_SHA;
  assert.equal(errorOf(() => buildGitIdentityV1(accessor)).code, 'accessor_property_denied');

  const symbolKeyed = gitInput();
  symbolKeyed[Symbol('hidden')] = 'nope';
  assert.equal(errorOf(() => buildGitIdentityV1(symbolKeyed)).code, 'symbol_key_denied');

  const exotic = Object.assign(Object.create({ inherited: true }), gitInput());
  assert.equal(errorOf(() => buildGitIdentityV1(exotic)).code, 'exotic_prototype_denied');

  const cycle = { repository_path: REPOSITORY_PATH, base_sha: BASE_SHA };
  cycle.self = cycle;
  assert.equal(errorOf(() => buildGitIdentityV1(cycle)).code, 'aliased_reference_denied');

  const shared = { path: REPOSITORY_PATH };
  const alias = { repository_path: REPOSITORY_PATH, base_sha: BASE_SHA, extra: shared, also: shared };
  assert.equal(errorOf(() => buildGitIdentityV1(alias)).code, 'aliased_reference_denied');

  const sparse = gitInput();
  sparse.tags = ['a'];
  sparse.tags[2] = 'c';
  assert.equal(errorOf(() => buildGitIdentityV1(sparse)).code, 'invalid_array');
});

test('own undefined, non-enumerable, and depth/size hostile inputs fail closed', () => {
  const undef = { repository_path: REPOSITORY_PATH, base_sha: BASE_SHA, extra: undefined };
  assert.equal(errorOf(() => buildGitIdentityV1(undef)).code, 'own_undefined_denied');

  const hidden = gitInput();
  Object.defineProperty(hidden, 'token', { enumerable: false, value: 'secret' });
  // Non-enumerable extra keys are still own keys; closure walks Reflect.ownKeys.
  const hiddenError = errorOf(() => buildGitIdentityV1(hidden));
  assert.ok(['non_enumerable_property_denied', 'credential_content_denied', 'unknown_key']
    .includes(hiddenError.code), hiddenError.code);

  let node = gitInput();
  for (let index = 0; index < 40; index += 1) node = { nested: node };
  assert.equal(errorOf(() => buildGitIdentityV1(node)).code, 'value_depth_exceeded');
});

test('content-class keys fail with dedicated codes and do not echo payloads', () => {
  const cases = [
    ['prompt', 'prompt_content_denied'],
    ['api_token', 'credential_content_denied'],
    ['environment', 'environment_content_denied'],
    ['argv', 'executable_content_denied'],
    ['workspace_mode', 'direct_mode_rejected'],
    ['result', 'result_content_denied'],
    ['diff', 'diff_content_denied'],
  ];
  for (const [key, code] of cases) {
    const input = gitInput();
    input[key] = 'ATTACKER-SECRET';
    const error = errorOf(() => buildGitIdentityV1(input));
    assert.equal(error.code, code, key);
    assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  }
});

test('invalid Git, workspace, and provider-run values fail with stable typed codes', () => {
  assert.equal(errorOf(() => buildGitIdentityV1({
    repository_path: 'relative/path',
    base_sha: BASE_SHA,
  })).code, 'invalid_format');
  assert.equal(errorOf(() => buildGitIdentityV1({
    repository_path: REPOSITORY_PATH,
    base_sha: 'not-a-sha',
  })).code, 'invalid_format');
  assert.equal(errorOf(() => buildWorkspaceIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    git: fixtureGit(),
    semantics: 'direct',
    starting_point: 'run_base_sha',
    worktree_path: '/run-fixtures/worktrees/backend-writer',
    branch: 'codex-co-engineer/runs/identity-under-test/backend-writer',
    lock_id: 'lock-backend-writer-01',
  })).code, 'invalid_format');
  assert.equal(errorOf(() => buildRunIdentityV1({
    run_id: RUN_ID,
    git: fixtureGit(),
    manifest_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })).code, 'invalid_format');
  assert.equal(errorOf(() => buildProviderRunIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    attempt: 1,
    provider: 'unknown',
    model: 'grok-4',
    git: fixtureGit(),
    manifest_digest: fixtureManifestDigest(),
    prompt_envelope_digest: fixtureEnvelopeDigest(),
    resolved_lane_digest: fixtureLaneDigest(),
    capability_snapshot_digest: fixtureCapabilityDigest(),
  })).code, 'unknown_provider');
  assert.equal(errorOf(() => validateGitIdentityV1({
    schema: 'codex-co-engineer.git-identity.v1',
    repository_path: REPOSITORY_PATH,
    base_sha: BASE_SHA,
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  })).code, 'identity_mismatch');
});

test('getters on nested git identities are never invoked', () => {
  let reads = 0;
  const git = fixtureGit();
  const hostile = { ...git };
  Object.defineProperty(hostile, 'base_sha', {
    enumerable: true,
    get() {
      reads += 1;
      return BASE_SHA;
    },
  });
  assert.equal(errorOf(() => buildWorkspaceIdentityV1({
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_ID,
    git: hostile,
    semantics: 'local_managed_worktree',
    starting_point: 'run_base_sha',
    worktree_path: '/run-fixtures/worktrees/backend-writer',
    branch: 'codex-co-engineer/runs/identity-under-test/backend-writer',
    lock_id: 'lock-backend-writer-01',
    starting_ref: null,
  })).code, 'accessor_property_denied');
  assert.equal(reads, 0);
});
