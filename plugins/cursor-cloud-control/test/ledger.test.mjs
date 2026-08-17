import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CursorApiError } from '../mcp/client.mjs';
import { SubmissionLedger, requestDigest, resolveStateDirectory } from '../mcp/ledger.mjs';

const digest = requestDigest('agents.create', { prompt: { text: 'inspect' } });
const otherDigest = requestDigest('agents.create', { prompt: { text: 'different' } });

async function stateFixture(context, prefix = 'cursor-ledger-test-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function assertLedgerError(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof CursorApiError);
    assert.equal(error.code, code);
    return true;
  });
}

function validRecord(overrides = {}) {
  return {
    requestId: 'request-1',
    kind: 'agents.create',
    digest,
    status: 'pending',
    agentId: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

test('configured state is created owner-only and readiness does not create a ledger record', async (context) => {
  const root = await stateFixture(context);
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });

  const readiness = await ledger.readiness();
  assert.deepEqual(readiness, {
    ready: true,
    directory: stateDir,
    source: 'explicit',
    durability: 'owner-only-local-ledger',
  });
  assert.equal((await lstat(stateDir)).mode & 0o777, 0o700);
  await assert.rejects(readFile(path.join(stateDir, 'submissions.json'), 'utf8'), { code: 'ENOENT' });
});

test('records persist across ledger instances and completed requests deduplicate safely', async (context) => {
  const root = await stateFixture(context);
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });

  const first = await ledger.begin({ requestId: 'request-1', kind: 'agents.create', digest });
  assert.equal(first.duplicate, false);
  assert.equal((await lstat(path.join(stateDir, 'submissions.json'))).mode & 0o777, 0o600);

  await ledger.complete('request-1', { agentId: 'agent-1' });
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'submissions.json'), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.deepEqual(persisted.records[0], await ledger.lookup('request-1'));

  const restarted = new SubmissionLedger({ stateDir });
  assert.deepEqual(await restarted.lookup('request-1'), persisted.records[0]);
  const duplicate = await restarted.begin({ requestId: 'request-1', kind: 'agents.create', digest, agentId: 'agent-2' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.record.agentId, 'agent-1');
  await assertLedgerError(
    () => restarted.begin({ requestId: 'request-1', kind: 'agents.create', digest: otherDigest }),
    'request_id_conflict',
  );
});

test('definitive failures leave a retryable reservation instead of a pending record', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-failed-retry-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });

  await ledger.begin({ requestId: 'failed-retry', kind: 'agents.create', digest });
  await ledger.fail('failed-retry', { failureCode: 'bad_request' });
  assert.equal((await ledger.lookup('failed-retry')).status, 'failed');

  const retry = await ledger.begin({ requestId: 'failed-retry', kind: 'agents.create', digest });
  assert.equal(retry.duplicate, false);
  assert.equal(retry.record.status, 'pending');
  assert.ok(retry.record.owner?.token);
});

test('finalization fails closed when the durable reservation disappears', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-missing-final-record-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  await ledger.begin({ requestId: 'missing-final-record', kind: 'agents.create', digest });
  await rm(path.join(stateDir, 'submissions.json'));

  for (const finalize of [
    () => ledger.complete('missing-final-record', { agentId: 'agent-1' }),
    () => ledger.fail('missing-final-record', { failureCode: 'bad_request' }),
    () => ledger.uncertain('missing-final-record', { agentId: 'agent-1' }),
  ]) {
    await assertLedgerError(finalize, 'ledger_record_missing');
  }
});

test('stale pending reservations become uncertain and persist reconciliation metadata after restart', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-stale-pending-');
  const stateDir = path.join(root, 'state');
  const old = '2026-08-17T00:00:00.000Z';
  const nowMs = Date.parse('2026-08-17T00:01:00.000Z');
  const original = new SubmissionLedger({ stateDir });
  await original.init();
  await writeFile(path.join(stateDir, 'submissions.json'), JSON.stringify({
    version: 1,
    records: [validRecord({
      requestId: 'stale-pending',
      createdAt: old,
      updatedAt: old,
      owner: { pid: 999_999, token: 'crashed-owner', startedAt: old },
    })],
  }), { mode: 0o600 });

  const restarted = new SubmissionLedger({ stateDir, pendingRecoveryMs: 1_000, clock: () => nowMs });
  const recovered = await restarted.lookup('stale-pending');
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.reconciliationRequired, true);
  assert.equal(recovered.recoveryReason, 'stale_pending');
  assert.equal(JSON.parse(await readFile(path.join(stateDir, 'submissions.json'), 'utf8')).records[0].status, 'uncertain');
  await assertLedgerError(
    () => restarted.begin({ requestId: 'stale-pending', kind: 'agents.create', digest }),
    'uncertain_submission',
  );
});

test('a read queued during begin persistence cannot clear the in-flight record', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-read-race-');
  const stateDir = path.join(root, 'state');
  const persistenceStarted = deferred();
  const releasePersistence = deferred();

  class BarrierLedger extends SubmissionLedger {
    async persistUnlocked() {
      persistenceStarted.resolve();
      await releasePersistence.promise;
      return super.persistUnlocked();
    }
  }

  const ledger = new BarrierLedger({ stateDir });
  const beginPromise = ledger.begin({ requestId: 'read-race', kind: 'agents.create', digest });
  await persistenceStarted.promise;

  let readSettled = false;
  const readPromise = ledger.lookup('read-race').then((record) => {
    readSettled = true;
    return record;
  });
  await Promise.resolve();
  assert.equal(readSettled, false, 'lookup should wait for the in-flight same-instance mutation');

  releasePersistence.resolve();
  const [beginResult, record] = await Promise.all([beginPromise, readPromise]);
  assert.equal(beginResult.duplicate, false);
  assert.deepEqual(record, beginResult.record);
  assert.deepEqual(await ledger.lookup('read-race'), beginResult.record);
});

test('parallel mutations from independent ledger instances merge without record loss', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-parallel-');
  const stateDir = path.join(root, 'state');
  await new SubmissionLedger({ stateDir }).init();
  const first = new SubmissionLedger({ stateDir });
  const second = new SubmissionLedger({ stateDir });

  const [firstResult, secondResult] = await Promise.all([
    first.begin({ requestId: 'parallel-1', kind: 'agents.create', digest }),
    second.begin({ requestId: 'parallel-2', kind: 'agents.create', digest }),
  ]);
  assert.equal(firstResult.duplicate, false);
  assert.equal(secondResult.duplicate, false);

  const persisted = JSON.parse(await readFile(path.join(stateDir, 'submissions.json'), 'utf8'));
  assert.deepEqual(persisted.records.map((record) => record.requestId).sort(), ['parallel-1', 'parallel-2']);

  const conflictState = path.join(root, 'conflict-state');
  await new SubmissionLedger({ stateDir: conflictState }).init();
  const conflictA = new SubmissionLedger({ stateDir: conflictState });
  const conflictB = new SubmissionLedger({ stateDir: conflictState });
  const outcomes = await Promise.allSettled([
    conflictA.begin({ requestId: 'parallel-same', kind: 'agents.create', digest }),
    conflictB.begin({ requestId: 'parallel-same', kind: 'agents.create', digest: otherDigest }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'request_id_conflict');
});

test('a live lock fails closed after the bounded wait instead of overwriting state', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-lock-timeout-');
  const stateDir = path.join(root, 'state');
  await new SubmissionLedger({ stateDir }).init();
  const lockDir = path.join(stateDir, 'submissions.lock');
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
    token: 'test-lock',
    pid: process.pid,
    createdAt: Date.now(),
  }), { mode: 0o600 });

  const blocked = new SubmissionLedger({ stateDir, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 0 });
  await assertLedgerError(
    () => blocked.begin({ requestId: 'blocked', kind: 'agents.create', digest }),
    'ledger_lock_timeout',
  );
  await assert.rejects(readFile(path.join(stateDir, 'submissions.json'), 'utf8'), { code: 'ENOENT' });
});

test('state-directory resolution honors explicit configuration and fails closed when it is empty or absent', async (context) => {
  const root = await stateFixture(context);
  assert.deepEqual(resolveStateDirectory({ CURSOR_CLOUD_CONTROL_STATE_DIR: path.join(root, 'explicit'), HOME: root }), {
    directory: path.join(root, 'explicit'),
    source: 'environment',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ CURSOR_CLOUD_CONTROL_STATE_DIR: '', HOME: root }), {
    directory: null,
    source: 'environment',
    reason: 'CURSOR_CLOUD_CONTROL_STATE_DIR is empty.',
  });
  assert.deepEqual(resolveStateDirectory({}), {
    directory: null,
    source: 'unconfigured',
    reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR or HOME/XDG_STATE_HOME before using Cursor mutations.',
  });

  const empty = new SubmissionLedger({ env: { CURSOR_CLOUD_CONTROL_STATE_DIR: '' } });
  const emptyReadiness = await empty.readiness();
  assert.equal(emptyReadiness.ready, false);
  assert.equal(emptyReadiness.code, 'ledger_unavailable');
  assert.match(emptyReadiness.reason, /empty/);

  const unconfigured = new SubmissionLedger({ env: {} });
  const unconfiguredReadiness = await unconfigured.readiness();
  assert.equal(unconfiguredReadiness.ready, false);
  assert.equal(unconfiguredReadiness.source, 'unconfigured');
  assert.equal(unconfiguredReadiness.code, 'ledger_unavailable');
  await assertLedgerError(() => unconfigured.lookup('request-1'), 'ledger_unavailable');
});

test('symlinked state directories and ledger files are rejected', async (context) => {
  const root = await stateFixture(context);
  const targetDirectory = await mkdtemp(path.join(root, 'target-directory-'));
  const linkedDirectory = path.join(root, 'linked-directory');
  await symlink(targetDirectory, linkedDirectory);
  await assertLedgerError(() => new SubmissionLedger({ stateDir: linkedDirectory }).lookup('request-1'), 'ledger_permissions');

  const stateDir = path.join(root, 'state');
  const targetFile = path.join(root, 'target-ledger.json');
  await new SubmissionLedger({ stateDir }).init();
  await writeFile(targetFile, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
  await symlink(targetFile, path.join(stateDir, 'submissions.json'));
  await assertLedgerError(() => new SubmissionLedger({ stateDir }).lookup('request-1'), 'ledger_permissions');
});

test('symlinked ancestor cannot redirect state creation into an external target', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-ancestor-link-');
  const external = path.join(root, 'external');
  const linkedParent = path.join(root, 'linked-parent');
  await mkdir(external, { mode: 0o700 });
  await symlink(external, linkedParent);

  const stateDir = path.join(linkedParent, 'nested-state');
  await assertLedgerError(() => new SubmissionLedger({ stateDir }).begin({
    requestId: 'request-ancestor-link',
    kind: 'agents.create',
    digest,
  }), 'ledger_permissions');
  await assert.rejects(lstat(path.join(external, 'nested-state')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(external, 'nested-state', 'submissions.json')), { code: 'ENOENT' });
});

test('group/world-readable or writable directories and ledger files are rejected', async (context) => {
  const directoryRoot = await stateFixture(context, 'cursor-ledger-directory-mode-');
  const unsafeDirectory = path.join(directoryRoot, 'state');
  await new SubmissionLedger({ stateDir: unsafeDirectory }).init();
  await chmod(unsafeDirectory, 0o705);
  await assertLedgerError(() => new SubmissionLedger({ stateDir: unsafeDirectory }).lookup('request-1'), 'ledger_permissions');

  const fileRoot = await stateFixture(context, 'cursor-ledger-file-mode-');
  const stateDir = path.join(fileRoot, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  await ledger.begin({ requestId: 'request-1', kind: 'agents.create', digest });
  await chmod(path.join(stateDir, 'submissions.json'), 0o604);
  await assertLedgerError(() => new SubmissionLedger({ stateDir }).lookup('request-1'), 'ledger_permissions');
});

test('invalid JSON, unsupported versions, and malformed records fail closed', async (context) => {
  const cases = [
    ['invalid JSON', '{not-json'],
    ['unsupported version', JSON.stringify({ version: 2, records: [] })],
    ['malformed record', JSON.stringify({ version: 1, records: [validRecord({ digest: 'not-a-digest' })] })],
    ['missing required record field', JSON.stringify({ version: 1, records: [{ requestId: 'request-1' }] })],
  ];

  for (const [label, contents] of cases) {
    const root = await stateFixture(context, `cursor-ledger-corrupt-${label.replaceAll(' ', '-')}-`);
    const stateDir = path.join(root, 'state');
    const ledger = new SubmissionLedger({ stateDir });
    await ledger.init();
    await writeFile(path.join(stateDir, 'submissions.json'), contents, { mode: 0o600 });
    await chmod(path.join(stateDir, 'submissions.json'), 0o600);
    await assertLedgerError(() => ledger.lookup('request-1'), 'ledger_corrupt');
  }
});

test('a path that cannot contain a state directory reports unavailable durable state', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-unavailable-');
  const regularFile = path.join(root, 'not-a-directory');
  await writeFile(regularFile, 'occupied', { mode: 0o600 });
  const ledger = new SubmissionLedger({ stateDir: path.join(regularFile, 'child') });

  const readiness = await ledger.readiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.code, 'ledger_unavailable');
  await assertLedgerError(() => ledger.begin({ requestId: 'request-1', kind: 'agents.create', digest }), 'ledger_unavailable');
});
