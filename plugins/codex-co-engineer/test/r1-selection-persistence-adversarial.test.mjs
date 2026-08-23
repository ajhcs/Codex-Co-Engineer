import assert from 'node:assert/strict';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';

import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  acceptSelectionReply,
  persistSelectionQuestionBatch,
} from '../mcp/v3/selection-persistence.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';
import {
  P27_RUN_ID,
  completeAnswers,
  derivedRequest,
  structuredReply,
  withSubmittedAnchor,
  wrapAnchor,
  writer,
} from './fixtures/r1-selection-persistence-fixtures.mjs';

function errorOf(action) {
  return Promise.resolve()
    .then(action)
    .then(() => assert.fail('expected a typed RunContractV1Error'), (error) => {
      assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
      return error;
    });
}

function assertNoSecret(error) {
  assert.doesNotMatch(error.message, /ATTACKER-SECRET/u);
  assert.doesNotMatch(error.message, /sk-live/u);
  assert.doesNotMatch(JSON.stringify(error), /ATTACKER-SECRET/u);
}

test('proxies accessors symbols sparse arrays and cycles fail closed with zero traps', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    const optionsProxy = countingProxy({ anchor, ...inputs });
    const proxied = await errorOf(() => persistSelectionQuestionBatch(optionsProxy.proxy));
    assert.equal(proxied.code, 'proxy_denied');
    assert.equal(trapTotal(optionsProxy.counts), 0);

    const availabilityProxy = countingProxy(inputs.availability);
    const availabilityDenied = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      availability: availabilityProxy.proxy,
    }));
    assert.equal(availabilityDenied.code, 'proxy_denied');
    assert.equal(trapTotal(availabilityProxy.counts), 0);

    let reads = 0;
    const accessed = structuredClone(inputs.manifest);
    Object.defineProperty(accessed, 'run_id', {
      enumerable: true,
      get() {
        reads += 1;
        return 'ATTACKER-SECRET';
      },
    });
    const accessor = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      manifest: accessed,
    }));
    assert.equal(accessor.code, 'accessor_property_denied');
    assert.equal(reads, 0);
    assertNoSecret(accessor);

    const symbolic = { ...inputs, [Symbol('secret')]: 'ATTACKER-SECRET' };
    const symbolError = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...symbolic,
    }));
    assert.ok(['unknown_key', 'symbol_key_denied'].includes(symbolError.code), symbolError.code);

    const cyclic = structuredClone(inputs.manifest);
    cyclic.self = cyclic;
    const cycle = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      manifest: cyclic,
    }));
    assert.equal(cycle.code, 'aliased_reference_denied');

    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const sparse = [];
    sparse[1] = { assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' };
    const sparseError = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, sparse),
    }));
    assert.ok([
      'non_enumerable_property_denied',
      'invalid_type',
      'invalid_array',
      'selection_answers_rejected',
      'invalid_json_type',
    ].includes(sparseError.code), sparseError.code);

    const { proxy, revoke } = Proxy.revocable(inputs.manifest, {
      get() { throw new Error('revoked get'); },
    });
    revoke();
    assert.equal(utilTypes.isProxy(proxy), true);
    const revoked = await errorOf(() => persistSelectionQuestionBatch({
      anchor,
      ...inputs,
      manifest: proxy,
    }));
    assert.equal(revoked.code, 'proxy_denied');
  });
});

test('oversized answers stale snapshots and model_only scope violations fail closed', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const before = await anchor.getCoordination(P27_RUN_ID);

    const oversized = completeAnswers(derived.request);
    for (let index = 0; index < 64; index += 1) {
      oversized.push({
        assignment_id: `overflow-${index}`,
        provider: 'grok',
        model: 'grok-4',
      });
    }
    const overflow = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, oversized),
    }));
    assert.equal(overflow.code, 'selection_answers_rejected');

    const staleAvailability = structuredClone(inputs.availability);
    staleAvailability.providers.dsh.status = 'unavailable';
    const stale = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      availability: staleAvailability,
      reply: structuredReply(derived.request),
    }));
    assert.ok(['stale_selection_request', 'selection_snapshot_mismatch'].includes(stale.code),
      stale.code);

    const after = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(after.state_digest, before.state_digest);
  });

  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    assert.equal(derived.request.questions[0].answer_scope, 'model_only');
    const withProvider = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, [
        { assignment_id: 'lane-0', provider: 'grok', model: 'grok-4' },
      ]),
    }));
    assert.equal(withProvider.code, 'selection_answers_rejected');
    const ok = await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request, [
        { assignment_id: 'lane-0', model: 'grok-4' },
      ]),
    });
    assert.equal(ok.created, true);
    assert.equal(ok.plan.assignments[0].provider, 'grok');
  }, {
    runId: 'p27-model-only-run',
    assignments: [writer('lane-0', ['src/lane-0/**'], { provider: 'grok', model: 'not-offered' })],
  });
});

test('tampered request and reply records are detected by the accepted R24A anchor', async () => {
  await withSubmittedAnchor(async ({ root, anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const requestPath = path.join(root, 'runs', P27_RUN_ID, 'selection-request.record.json');
    const honest = await readFile(requestPath);
    const parsed = JSON.parse(honest.toString('utf8').trim());
    parsed.objective = 'ATTACKER-SECRET';
    await writeFile(requestPath, `${canonicalJsonStringify(parsed)}\n`);
    const tampered = await errorOf(() => persistSelectionQuestionBatch({ anchor, ...inputs }));
    assert.ok([
      'aggregate_run_record_corruption',
      'unknown_selection_request_key',
      'invalid_selection_request',
    ].includes(tampered.code), tampered.code);
    assertNoSecret(tampered);
    await writeFile(requestPath, honest);

    const derived = derivedRequest(inputs);
    await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    });
    const replyPath = path.join(root, 'runs', P27_RUN_ID, 'selection-reply.record.json');
    const honestReply = await readFile(replyPath);
    const replyParsed = JSON.parse(honestReply.toString('utf8').trim());
    replyParsed.answers[0].model = 'ATTACKER-SECRET';
    await writeFile(replyPath, `${canonicalJsonStringify(replyParsed)}\n`);
    const replyTamper = await errorOf(() => acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    }));
    assert.ok(typeof replyTamper.code === 'string');
    assertNoSecret(replyTamper);
  });
});

test('run and root swaps fail closed without leaking the foreign path', async () => {
  await withSubmittedAnchor(async ({ root, anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const moved = `${root}.moved`;
    await rename(root, moved);
    const swapped = await errorOf(() => persistSelectionQuestionBatch({ anchor, ...inputs }));
    assert.ok(typeof swapped.code === 'string');
    assertNoSecret(swapped);
    assert.doesNotMatch(swapped.message, new RegExp(moved.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    await rename(moved, root);
  });
});

test('failure injection before reply commit plus restart does not create a second batch', async () => {
  await withSubmittedAnchor(async ({ anchor, inputs }) => {
    await persistSelectionQuestionBatch({ anchor, ...inputs });
    const derived = derivedRequest(inputs);
    const wrapped = wrapAnchor(anchor, {
      beforeCommitResolution: async () => {
        throw new RunContractV1Error('injected_before_resolution', 'commit', 'injected before reply');
      },
    });
    const injected = await errorOf(() => acceptSelectionReply({
      anchor: wrapped,
      ...inputs,
      reply: structuredReply(derived.request),
    }));
    assert.equal(injected.code, 'injected_before_resolution');
    const coordination = await anchor.getCoordination(P27_RUN_ID);
    assert.equal(coordination.phase, 'awaiting_selection');
    assert.equal(coordination.revision, 1);
    const completed = await acceptSelectionReply({
      anchor,
      ...inputs,
      reply: structuredReply(derived.request),
    });
    assert.equal(completed.created, true);
    assert.equal(completed.disposition, 'resolution_ready');
  });
});

test('the facade imports no provider workspace supervisor server or dispatch surfaces', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../mcp/v3/selection-persistence.mjs', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(source, /from '\.\/supervisor\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/server\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/acp-worker\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/cursor-cloud-worker\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/task-store\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/run-store\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/run-reducer\.mjs'/u);
  assert.doesNotMatch(source, /commitResolvedPlan\(/u);
  assert.match(source, /commitSelectionRequest/u);
  assert.match(source, /commitSelectionResolution/u);
  assert.match(source, /bindAggregateResolution/u);
  assert.match(source, /no_selection_required/u);
});
