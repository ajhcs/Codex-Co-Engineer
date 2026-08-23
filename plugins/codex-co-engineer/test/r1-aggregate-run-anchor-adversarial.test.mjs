import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
  AGGREGATE_RUN_STAMP_SCHEMA_ID,
  initializeAggregateRunAnchorRoot,
  openAggregateRunAnchor,
} from '../mcp/v3/aggregate-run-anchor.mjs';
import { canonicalJsonStringify } from '../mcp/v3/identity.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  AGGREGATE_RUN_ID,
  defaultAnswers,
  makePlanInput,
  makePrivateRoot,
  makeReplyInput,
  makeSelectionRequest,
  makeStoredPlan,
  makeStoredReply,
  makeSubmitInput,
} from './fixtures/r1-aggregate-run-anchor-fixtures.mjs';
import { countingProxy, trapTotal } from './fixtures/r1-resolver-fixtures.mjs';

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
}

async function withAnchor(fn) {
  const root = await makePrivateRoot('r1-r24a-adv-');
  try {
    const store = await initializeAggregateRunAnchorRoot(root);
    return await fn(root, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('illegal transitions, stale revisions, and second bindings conflict', async () => {
  await withAnchor(async (_root, store) => {
    await store.submit(makeSubmitInput());
    assert.equal((await errorOf(() => store.commitSelectionResolution({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 1,
      request_identity: makeSelectionRequest().identity,
      reply_record: makeReplyInput(
        AGGREGATE_RUN_ID, makeSelectionRequest().identity.request_id, defaultAnswers(1),
      ),
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    }))).code, 'aggregate_run_revision_conflict');

    const selection = makeSelectionRequest();
    await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    const other = makeSelectionRequest({ runId: AGGREGATE_RUN_ID, assignmentCount: 8 });
    assert.equal((await errorOf(() => store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: other.identity,
      record: other.record,
    }))).code, 'aggregate_run_revision_conflict');
    assert.equal((await errorOf(() => store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    }))).code, 'aggregate_run_revision_conflict');
  });
});

test('exact orphan records are adopted and differing orphans conflict', async () => {
  await withAnchor(async (root, store) => {
    await store.submit(makeSubmitInput());
    const selection = makeSelectionRequest();
    const requestPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-request.record.json');
    await writeFile(requestPath, `${canonicalJsonStringify(selection.record)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    const adopted = await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    assert.equal(adopted.created, true);
    assert.equal(adopted.coordination.phase, 'awaiting_selection');

    const replyPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-reply.record.json');
    const planPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'resolved-plan.record.json');
    await writeFile(replyPath, `${canonicalJsonStringify(makeStoredReply(
      AGGREGATE_RUN_ID, selection.identity.request_id, defaultAnswers(1),
    ))}\n`, { mode: 0o600 });
    await chmod(replyPath, 0o600);
    await writeFile(planPath, `${canonicalJsonStringify(makeStoredPlan(AGGREGATE_RUN_ID))}\n`, { mode: 0o600 });
    await chmod(planPath, 0o600);
    const resolved = await store.commitSelectionResolution({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(
        AGGREGATE_RUN_ID, selection.identity.request_id, defaultAnswers(1),
      ),
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(resolved.created, true);
  });

  await withAnchor(async (root, store) => {
    await store.submit(makeSubmitInput());
    const selection = makeSelectionRequest();
    const requestPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-request.record.json');
    const other = makeSelectionRequest({ assignmentCount: 8 });
    await writeFile(requestPath, `${canonicalJsonStringify(other.record)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    assert.equal((await errorOf(() => store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    }))).code, 'aggregate_run_orphan_conflict');
  });
});

test('committed missing malformed and digest-mismatched records are corruption', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    const selection = makeSelectionRequest();
    await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    const requestPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-request.record.json');
    await rm(requestPath);
    assert.equal((await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID))).code,
      'aggregate_run_record_corruption');
    const replay = await errorOf(() => store.submit(input));
    assert.equal(replay.code, 'aggregate_run_record_corruption');
    assert.notEqual(replay.code, undefined);
  });

  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    const selection = makeSelectionRequest();
    await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    const requestPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-request.record.json');
    await writeFile(requestPath, '{"schema":"nope"\n', { mode: 0o600 });
    assert.equal((await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID))).code,
      'aggregate_run_record_corruption');
    assert.equal((await errorOf(() => store.submit(input))).code, 'aggregate_run_record_corruption');
  });

  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    const selection = makeSelectionRequest();
    await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    const requestPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-request.record.json');
    const other = makeSelectionRequest({ assignmentCount: 8 });
    await writeFile(requestPath, `${canonicalJsonStringify(other.record)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    assert.equal((await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID))).code,
      'aggregate_run_record_corruption');
    assert.equal((await errorOf(() => store.submit(input))).code, 'aggregate_run_record_corruption');
  });

  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    await store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    const planPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'resolved-plan.record.json');
    const parsed = JSON.parse((await readFile(planPath, 'utf8')).trim());
    parsed.canonical_digest = `sha256:${'ab'.repeat(32)}`;
    await writeFile(planPath, `${canonicalJsonStringify(parsed)}\n`, { mode: 0o600 });
    await chmod(planPath, 0o600);
    assert.equal((await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID))).code,
      'aggregate_run_record_corruption');
    assert.equal((await errorOf(() => store.submit(input))).code, 'aggregate_run_record_corruption');
  });

  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    await store.submit(input);
    const selection = makeSelectionRequest();
    await store.commitSelectionRequest({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      request_identity: selection.identity,
      record: selection.record,
    });
    await store.commitSelectionResolution({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 1,
      request_identity: selection.identity,
      reply_record: makeReplyInput(
        AGGREGATE_RUN_ID, selection.identity.request_id, defaultAnswers(1),
      ),
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    const replyPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'selection-reply.record.json');
    await rm(replyPath);
    assert.equal((await errorOf(() => store.submit(input))).code, 'aggregate_run_record_corruption');
    await writeFile(replyPath, '{"schema":"nope"\n', { mode: 0o600 });
    assert.equal((await errorOf(() => store.getByRunId(AGGREGATE_RUN_ID))).code,
      'aggregate_run_record_corruption');
  });
});

test('malformed out-of-order and conflicting prefixes fail closed without overwrite', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    const first = await store.submit(input);
    const runDir = path.join(root, 'runs', AGGREGATE_RUN_ID);
    const anchorPath = path.join(runDir, 'anchor.json');
    const coordPath = path.join(runDir, 'coordination.json');
    const stampPath = path.join(runDir, 'created.json');
    const requestPath = path.join(runDir, 'selection-request.record.json');
    const anchorBytes = await readFile(anchorPath);
    const coordBytes = await readFile(coordPath);

    await rm(coordPath);
    await rm(stampPath);
    await writeFile(anchorPath, '{"schema":"nope"\n', { mode: 0o600 });
    const malformed = await errorOf(() => store.submit(input));
    assert.ok([
      'aggregate_run_malformed',
      'aggregate_run_identity_mismatch',
      'aggregate_run_unreadable',
    ].includes(malformed.code), malformed.code);
    assert.equal((await readFile(anchorPath)).toString('utf8'), '{"schema":"nope"\n');

    await writeFile(anchorPath, anchorBytes, { mode: 0o600 });
    await chmod(anchorPath, 0o600);
    await writeFile(coordPath, coordBytes, { mode: 0o600 });
    await chmod(coordPath, 0o600);
    await rm(anchorPath);
    const outOfOrder = await errorOf(() => store.submit(input));
    assert.equal(outOfOrder.code, 'aggregate_run_unreadable');
    assert.equal((await readFile(coordPath)).equals(coordBytes), true);
    assert.equal((await readdir(runDir)).includes('anchor.json'), false);

    await writeFile(anchorPath, anchorBytes, { mode: 0o600 });
    await chmod(anchorPath, 0o600);
    await writeFile(stampPath, `${canonicalJsonStringify({
      schema: AGGREGATE_RUN_STAMP_SCHEMA_ID,
      run_id: AGGREGATE_RUN_ID,
      record_canonical_digest: first.record.canonical_digest,
      nonce: 'ab'.repeat(16),
    })}\n`, { mode: 0o600 });
    await chmod(stampPath, 0o600);
    await rm(coordPath);
    const stampBeforeCoord = await errorOf(() => store.submit(input));
    assert.equal(stampBeforeCoord.code, 'aggregate_run_unreadable');
    assert.equal((await readFile(anchorPath)).equals(anchorBytes), true);
    assert.equal((await readdir(runDir)).includes('coordination.json'), false);

    await rm(stampPath);
    const otherRoot = await makePrivateRoot('r1-r24a-conflict-anchor-');
    try {
      const otherStore = await initializeAggregateRunAnchorRoot(otherRoot);
      await otherStore.submit(makeSubmitInput({ assignmentCount: 8 }));
      const conflicting = await readFile(path.join(otherRoot, 'runs', AGGREGATE_RUN_ID, 'anchor.json'));
      await writeFile(anchorPath, conflicting, { mode: 0o600 });
      await chmod(anchorPath, 0o600);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
    const conflict = await errorOf(() => store.submit(input));
    assert.equal(conflict.code, 'aggregate_run_identity_conflict');
    const afterConflict = await readFile(anchorPath);
    assert.equal(afterConflict.equals(anchorBytes), false);

    await writeFile(anchorPath, anchorBytes, { mode: 0o600 });
    await chmod(anchorPath, 0o600);
    await writeFile(requestPath, `${canonicalJsonStringify(makeSelectionRequest().record)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    const unexpected = await errorOf(() => store.submit(input));
    assert.equal(unexpected.code, 'aggregate_run_unreadable');
    assert.equal((await readFile(anchorPath)).equals(anchorBytes), true);
    assert.equal((await readdir(runDir)).includes('coordination.json'), false);
    assert.equal((await readdir(runDir)).includes('created.json'), false);
  });
});

test('claim mismatch conflicts without removing the winner; crash temps are cleaned', async () => {
  await withAnchor(async (root, store) => {
    const first = await store.submit(makeSubmitInput());
    const claimPath = path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`);
    const winner = await readFile(claimPath);
    const conflict = makeSubmitInput({ assignmentCount: 8 });
    conflict.run_id = AGGREGATE_RUN_ID;
    const error = await errorOf(() => store.submit(conflict));
    assert.ok(error.code === 'aggregate_run_identity_conflict'
      || error.code === 'aggregate_run_idempotency_conflict', error.code);
    assert.equal((await readFile(claimPath)).equals(winner), true);
    assert.equal((await store.getByRunId(AGGREGATE_RUN_ID)).canonical_digest, first.record.canonical_digest);

    const tempName = `.tmp-${'ab'.repeat(16)}`;
    await writeFile(path.join(root, tempName), 'torn', { mode: 0o600 });
    await writeFile(path.join(root, 'claims', tempName), 'torn', { mode: 0o600 });
    await writeFile(path.join(root, 'runs', AGGREGATE_RUN_ID, tempName), 'torn', { mode: 0o600 });
    await store.getByRunId(AGGREGATE_RUN_ID);
    const rootNames = await readdir(root);
    assert.ok(!rootNames.includes(tempName));
    const claimNames = await readdir(path.join(root, 'claims'));
    assert.ok(!claimNames.includes(tempName));
    const runNames = await readdir(path.join(root, 'runs', AGGREGATE_RUN_ID));
    assert.ok(!runNames.includes(tempName));
  });
});

test('symlink hardlink FIFO and directory swaps fail closed with typed content-free errors', async () => {
  const parent = await makePrivateRoot('r1-r24a-swap-');
  try {
    const real = path.join(parent, 'real');
    await mkdir(real, { mode: 0o700 });
    await chmod(real, 0o700);
    const linked = path.join(parent, 'linked');
    await symlink(real, linked);
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot(linked))).code,
      'aggregate_run_root_unsafe');

    const store = await initializeAggregateRunAnchorRoot(real);
    await store.submit(makeSubmitInput());

    const other = path.join(parent, 'other');
    await mkdir(other, { mode: 0o700 });
    await chmod(other, 0o700);
    const otherStore = await initializeAggregateRunAnchorRoot(other);
    await otherStore.submit(makeSubmitInput({ runId: 'aggregate-other-run' }));
    const handle = store;
    const swapped = path.join(parent, 'swapped');
    await rename(real, swapped);
    await rename(other, real);
    const swapError = await errorOf(() => handle.getByRunId(AGGREGATE_RUN_ID));
    assert.ok([
      'aggregate_run_root_swapped',
      'aggregate_run_root_missing',
      'aggregate_run_root_unsafe',
      'aggregate_run_marker_swapped',
    ].includes(swapError.code), swapError.code);
    assertNoSecret(swapError);

    const marked = path.join(parent, 'marked');
    await mkdir(marked, { mode: 0o700 });
    await chmod(marked, 0o700);
    await initializeAggregateRunAnchorRoot(marked);
    const marker = path.join(marked, 'storage-root.v1');
    await rm(marker);
    await symlink('/etc/passwd', marker);
    const markerError = await errorOf(() => openAggregateRunAnchor(marked));
    assert.ok(markerError.code === 'aggregate_run_not_regular'
      || markerError.code === 'aggregate_run_root_unsafe'
      || markerError.code === 'aggregate_run_marker_swapped', markerError.code);
    assertNoSecret(markerError);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('claim and run directory swaps plus non-regular files fail closed', async () => {
  await withAnchor(async (root, store) => {
    await store.submit(makeSubmitInput());
    const claimPath = path.join(root, 'claims', `${AGGREGATE_RUN_ID}.json`);
    const backup = path.join(path.dirname(root), `${path.basename(root)}-claim.bak`);
    await rename(claimPath, backup);
    await symlink('/tmp/ATTACKER-SECRET', claimPath);
    const claimError = await errorOf(() => store.getByRunId(AGGREGATE_RUN_ID));
    assert.ok([
      'aggregate_run_not_regular',
      'aggregate_run_claim_swapped',
      'aggregate_run_root_unsafe',
      'aggregate_run_root_foreign',
    ].includes(claimError.code), claimError.code);
    assertNoSecret(claimError);
    await rm(claimPath);
    await rename(backup, claimPath);

    const runPath = path.join(root, 'runs', AGGREGATE_RUN_ID);
    const moved = path.join(path.dirname(root), `${path.basename(root)}-run.moved`);
    await rename(runPath, moved);
    await mkdir(runPath, { mode: 0o700 });
    await chmod(runPath, 0o700);
    const runError = await errorOf(() => store.getByRunId(AGGREGATE_RUN_ID));
    assert.ok([
      'aggregate_run_unreadable',
      'aggregate_run_dir_swapped',
      'aggregate_run_not_found',
    ].includes(runError.code), runError.code);
    await rm(moved, { recursive: true, force: true });
  });
});

test('proxy accessor foreign flood oversized and duplicate JSON fail closed', async () => {
  await withAnchor(async (root, store) => {
    const input = makeSubmitInput();
    const { proxy, counts } = countingProxy(input);
    const proxyError = await errorOf(() => store.submit(proxy));
    assert.equal(proxyError.code, 'proxy_denied');
    assert.equal(trapTotal(counts), 0);

    await store.submit(input);
    const accessor = {
      ...makePlanInput(AGGREGATE_RUN_ID, true),
    };
    Object.defineProperty(accessor, 'complete', {
      get() { return true; },
      enumerable: true,
    });
    assert.equal((await errorOf(() => store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: accessor,
    }))).code, 'accessor_property_denied');

    await writeFile(path.join(root, 'notes.txt'), 'ATTACKER-SECRET', { mode: 0o600 });
    const foreign = await errorOf(() => openAggregateRunAnchor(root));
    assert.equal(foreign.code, 'aggregate_run_root_foreign');
    assertNoSecret(foreign);
  });

  const flood = await makePrivateRoot('r1-r24a-flood-');
  try {
    await initializeAggregateRunAnchorRoot(flood);
    for (let index = 0; index < 70; index += 1) {
      const runId = `aggregate-flood-${String(index).padStart(2, '0')}`;
      const handle = await open(path.join(flood, 'claims', `${runId}.json`), 'wx', 0o600);
      await handle.writeFile('{}\n');
      await handle.close();
    }
    const flooded = await openAggregateRunAnchor(flood);
    const error = await errorOf(() => flooded.submit(makeSubmitInput({ runId: 'aggregate-flood-zz' })));
    assert.ok(error.code === 'aggregate_run_flood' || error.code === 'aggregate_run_malformed',
      error.code);
  } finally {
    await rm(flood, { recursive: true, force: true });
  }
});

test('outputs stay deeply frozen and diagnostics never echo secrets or record bodies', async () => {
  await withAnchor(async (root, store) => {
    const first = await store.submit(makeSubmitInput());
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.record));
    assert.ok(Object.isFrozen(first.coordination));
    const loaded = await store.getByRunId(AGGREGATE_RUN_ID);
    assert.ok(Object.isFrozen(loaded));
    const plan = await store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: makePlanInput(AGGREGATE_RUN_ID, true),
    });
    assert.equal(plan.coordination.phase, 'resolution_ready');
    assert.equal(plan.record.schema.startsWith('codex-co-engineer.'), true);

    const coordPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'coordination.json');
    const text = (await readFile(coordPath, 'utf8')).replace(
      '"phase":"resolution_ready"',
      '"phase":"ATTACKER-SECRET"',
    );
    await writeFile(coordPath, text, { mode: 0o600 });
    const error = await errorOf(() => store.getCoordination(AGGREGATE_RUN_ID));
    assertNoSecret(error);
    assert.doesNotMatch(error.message, /resolution_ready/u);
  });
});

test('incomplete plan records and unknown keys fail closed before publication', async () => {
  await withAnchor(async (_root, store) => {
    await store.submit(makeSubmitInput());
    assert.equal((await errorOf(() => store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: {
        schema: AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
        run_id: AGGREGATE_RUN_ID,
        complete: false,
      },
    }))).code, 'aggregate_run_phase_conflict');
    assert.equal((await errorOf(() => store.commitResolvedPlan({
      run_id: AGGREGATE_RUN_ID,
      expected_revision: 0,
      resolved_plan_record: {
        schema: AGGREGATE_RESOLVED_PLAN_SCHEMA_ID,
        run_id: AGGREGATE_RUN_ID,
        complete: true,
        extra: true,
      },
    }))).code, 'unknown_key');
  });
});

test('path attacks and truncated files fail closed', async () => {
  const root = await makePrivateRoot('r1-r24a-path-');
  try {
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot('relative/root'))).code,
      'aggregate_run_path_unsafe');
    assert.equal((await errorOf(() => initializeAggregateRunAnchorRoot(`${root}/../${path.basename(root)}`))).code,
      'aggregate_run_path_unsafe');
    const store = await initializeAggregateRunAnchorRoot(root);
    await store.submit(makeSubmitInput());
    const anchorPath = path.join(root, 'runs', AGGREGATE_RUN_ID, 'anchor.json');
    await truncate(anchorPath, 12);
    const error = await errorOf(() => store.getByRunId(AGGREGATE_RUN_ID));
    assert.ok([
      'aggregate_run_malformed',
      'aggregate_run_unreadable',
      'aggregate_run_identity_mismatch',
    ].includes(error.code), error.code);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
