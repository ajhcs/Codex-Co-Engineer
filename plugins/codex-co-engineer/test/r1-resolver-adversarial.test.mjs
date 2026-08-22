import assert from 'node:assert/strict';
import test from 'node:test';
import { types as utilTypes } from 'node:util';

import {
  assertDirectJsonClosure,
  classifySelectionAnswersV1,
  resolveRunSelectionV1,
  resolveSelectionAnswersV1,
  validateSelectionRequestV1,
} from '../mcp/v3/resolver.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  availabilitySnapshot,
  capabilitySnapshot,
  countingProxy,
  resolveInputs,
  reviewer,
  runManifest,
  trapTotal,
  writer,
} from './fixtures/r1-resolver-fixtures.mjs';

function errorOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
    return error;
  }
  assert.fail('expected a typed RunContractV1Error');
}

test('live proxies on every public resolver surface fire zero traps', () => {
  const manifest = runManifest([reviewer('lane-0', 'omitted')]);
  const availability = countingProxy(availabilitySnapshot());
  const capabilities = countingProxy(capabilitySnapshot());
  const options = countingProxy(resolveInputs(manifest));

  assert.equal(errorOf(() => resolveRunSelectionV1(options.proxy)).code, 'proxy_denied');
  assert.equal(trapTotal(options.counts), 0);

  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(manifest, { availability: availability.proxy }))).code,
    'proxy_denied',
  );
  assert.equal(trapTotal(availability.counts), 0);

  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(manifest, { capabilities: capabilities.proxy }))).code,
    'proxy_denied',
  );
  assert.equal(trapTotal(capabilities.counts), 0);
});

test('revoked proxies are denied before Array.isArray or Reflect', () => {
  const target = availabilitySnapshot();
  const { proxy, revoke } = Proxy.revocable(target, {
    get() { throw new Error('revoked get'); },
    ownKeys() { throw new Error('revoked ownKeys'); },
    getOwnPropertyDescriptor() { throw new Error('revoked descriptor'); },
  });
  revoke();
  assert.equal(utilTypes.isProxy(proxy), true);
  const error = errorOf(() => resolveRunSelectionV1(resolveInputs(
    runManifest([reviewer('lane-0', 'omitted')]),
    { availability: proxy },
  )));
  assert.equal(error.code, 'proxy_denied');
  assert.throws(() => Array.isArray(proxy), TypeError);
  assert.throws(() => Reflect.ownKeys(proxy), TypeError);
});

test('getters and reflection traps are never invoked', () => {
  let reads = 0;
  const availability = availabilitySnapshot();
  Object.defineProperty(availability, 'schema', {
    enumerable: true,
    get() {
      reads += 1;
      return 'codex-co-engineer.provider-availability.v1';
    },
  });
  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(
      runManifest([reviewer('lane-0', 'omitted')]),
      { availability },
    ))).code,
    'accessor_property_denied',
  );
  assert.equal(reads, 0);

  const symbolObject = availabilitySnapshot();
  symbolObject[Symbol('hidden')] = true;
  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(
      runManifest([reviewer('lane-0', 'omitted')]),
      { availability: symbolObject },
    ))).code,
    'symbol_key_denied',
  );
});

test('own undefined is denied while absence remains allowed', () => {
  const withUndefined = availabilitySnapshot();
  withUndefined.providers.grok.models = undefined;
  assert.equal(
    errorOf(() => resolveRunSelectionV1(resolveInputs(
      runManifest([reviewer('lane-0', 'omitted')]),
      { availability: withUndefined },
    ))).code,
    'own_undefined_denied',
  );

  const absentModels = availabilitySnapshot({ grok: { status: 'available' } });
  const plan = resolveRunSelectionV1(resolveInputs(
    runManifest([writer('lane-0', ['src/**'], { provider: 'grok', model: 'grok-4' })]),
    { availability: absentModels },
  ));
  assert.equal(plan.complete, true);
});

test('snapshot drift and forged request identity fail closed', () => {
  const manifest = runManifest([reviewer('lane-0', 'omitted')]);
  const original = resolveRunSelectionV1(resolveInputs(manifest));
  const request = original.selection_request;
  const driftedAvailability = availabilitySnapshot({
    grok: { status: 'unavailable', models: ['grok-4'] },
  });
  assert.equal(
    errorOf(() => resolveSelectionAnswersV1({
      ...resolveInputs(manifest, { availability: driftedAvailability }),
      request,
      answers: [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }],
      replyIdentity: {
        run_id: request.run_id,
        request_id: request.request_id,
        digest: request.digest,
      },
    })).code,
    'selection_snapshot_mismatch',
  );

  const forged = { ...request, request_id: 'sel-' + '0'.repeat(32) };
  assert.equal(errorOf(() => validateSelectionRequestV1(forged)).code, 'selection_request_id_mismatch');

  const digestForged = { ...request, digest: 'sha256:' + 'ab'.repeat(32) };
  assert.equal(
    errorOf(() => validateSelectionRequestV1(digestForged)).code,
    'selection_request_digest_mismatch',
  );
});

test('assertDirectJsonClosure rejects aliases, sparse arrays, and exotic prototypes', () => {
  const shared = { a: 1 };
  assert.equal(errorOf(() => assertDirectJsonClosure({ left: shared, right: shared }, '$')).code,
    'aliased_reference_denied');

  const sparse = [];
  sparse[1] = 'x';
  assert.equal(errorOf(() => assertDirectJsonClosure(sparse, '$')).code, 'invalid_array');

  const exotic = Object.create({ inherited: true });
  exotic.visible = 1;
  assert.equal(errorOf(() => assertDirectJsonClosure(exotic, '$')).code, 'exotic_prototype_denied');
});

test('classifySelectionAnswersV1 requires the full reply identity triple as own properties', () => {
  const plan = resolveRunSelectionV1(resolveInputs(runManifest([reviewer('lane-0', 'omitted')])));
  const request = plan.selection_request;
  const answers = [{ assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' }];

  const missing = classifySelectionAnswersV1(request, answers, undefined);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.some((problem) => problem.code === 'reply_identity_required'));

  const empty = {};
  const inheritedResult = classifySelectionAnswersV1(request, answers, empty);
  assert.equal(inheritedResult.ok, false);
  assert.ok(inheritedResult.problems.some((problem) => problem.code === 'incomplete_reply_identity'));

  const proto = {
    run_id: request.run_id,
    request_id: request.request_id,
    digest: request.digest,
  };
  const exotic = Object.create(proto);
  const exoticResult = errorOf(() => classifySelectionAnswersV1(request, answers, exotic));
  assert.ok(['invalid_reply_identity', 'exotic_prototype_denied'].includes(exoticResult.code));

  const partial = { run_id: request.run_id, request_id: request.request_id };
  const partialResult = classifySelectionAnswersV1(request, answers, partial);
  assert.equal(partialResult.ok, false);
  assert.ok(partialResult.problems.some((problem) => problem.code === 'incomplete_reply_identity'));

  const mismatch = classifySelectionAnswersV1(request, answers, {
    run_id: request.run_id,
    request_id: request.request_id,
    digest: 'sha256:' + 'cd'.repeat(32),
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.problems.some((problem) => problem.code === 'stale_digest'));
});
