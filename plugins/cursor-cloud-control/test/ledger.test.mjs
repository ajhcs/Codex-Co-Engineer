import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CursorApiError } from '../mcp/client.mjs';
import {
  SubmissionLedger,
  requestDigest,
  resolveStateDirectory,
  secureLedgerOpenFlags,
} from '../mcp/ledger.mjs';

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

function runLedgerChild(stateDir, requestId) {
  const source = `import { SubmissionLedger, requestDigest } from ${JSON.stringify(new URL('../mcp/ledger.mjs', import.meta.url).href)};
const ledger = new SubmissionLedger({ stateDir: ${JSON.stringify(stateDir)}, lockTimeoutMs: 2000, lockRetryMs: 1, lockStaleMs: 25 });
const digest = requestDigest('child', ${JSON.stringify(requestId)});
try { await ledger.begin({ requestId: ${JSON.stringify(requestId)}, kind: 'child', digest }); process.stdout.write('ok'); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
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

test('ledger open flags fail closed when the runtime exposes O_NOFOLLOW as zero', () => {
  assert.throws(
    () => secureLedgerOpenFlags(0, 0),
    (error) => error instanceof CursorApiError && error.code === 'ledger_unavailable',
  );
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

test('provider-ID reservations still block a failed-request retry when another request is uncertain', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-provider-id-conflict-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  const providerAgentId = 'bc-00000000-0000-0000-0000-000000000001';

  await ledger.begin({ requestId: 'failed-request-1', kind: 'agents.create', digest, agentId: providerAgentId, providerAgentId });
  await ledger.fail('failed-request-1', { failureCode: 'bad_request' });
  await ledger.begin({ requestId: 'uncertain-request-2', kind: 'agents.create', digest: otherDigest, agentId: providerAgentId, providerAgentId });
  await ledger.uncertain('uncertain-request-2', { agentId: providerAgentId });

  await assertLedgerError(
    () => ledger.begin({ requestId: 'failed-request-1', kind: 'agents.create', digest, agentId: providerAgentId, providerAgentId }),
    'uncertain_submission',
  );
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

test('record cap evicts terminal history only and preserves all active reservations across restart', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-active-cap-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  await ledger.init();
  const current = new Date().toISOString();
  const records = [
    validRecord({ requestId: 'active-pending-first', updatedAt: current, status: 'pending' }),
    ...Array.from({ length: 510 }, (_, index) => validRecord({ requestId: `terminal-${index.toString().padStart(3, '0')}`, status: 'completed' })),
    validRecord({ requestId: 'active-uncertain-last', status: 'uncertain', agentId: 'agent-active', providerAgentId: 'agent-active' }),
  ];
  await writeFile(path.join(stateDir, 'submissions.json'), JSON.stringify({ version: 1, records }), { mode: 0o600 });

  const restarted = new SubmissionLedger({ stateDir });
  assert.equal((await restarted.lookup('active-pending-first')).status, 'pending');
  assert.equal((await restarted.lookup('active-uncertain-last')).status, 'uncertain');
  assert.equal((await restarted.lookup('terminal-000')), null);
  assert.equal((await restarted.lookup('terminal-509')).status, 'completed');

  await restarted.begin({ requestId: 'cap-trigger-write', kind: 'agents.create', digest });
  const persisted = JSON.parse(await readFile(path.join(stateDir, 'submissions.json'), 'utf8')).records;
  assert.ok(persisted.some((record) => record.requestId === 'active-pending-first'));
  assert.ok(persisted.some((record) => record.requestId === 'active-uncertain-last'));
  assert.ok(persisted.filter((record) => !['pending', 'uncertain'].includes(record.status)).length <= 500);
});

test('retry clears prior reconciliation metadata before starting a new attempt', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-retry-metadata-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  const providerAgentId = 'agent-retry-metadata';
  await ledger.begin({ requestId: 'retry-metadata-1', kind: 'agents.create', digest, agentId: providerAgentId, providerAgentId });
  await ledger.uncertain('retry-metadata-1', {
    agentId: providerAgentId,
    providerAgentId,
    reconciliationReason: 'old-observation',
    reconciliationRequired: true,
    reconciledAt: '2026-08-17T00:01:00.000Z',
    staleAt: '2026-08-17T00:01:00.000Z',
    recoveryReason: 'stale_pending',
    failureCode: 'old_failure',
    providerCode: 'old_provider_code',
  });
  await ledger.reconcile('retry-metadata-1', { agentId: providerAgentId });
  const retry = await ledger.begin({ requestId: 'retry-metadata-1', kind: 'agents.create', digest, agentId: providerAgentId, providerAgentId });
  assert.equal(retry.record.status, 'pending');
  for (const field of ['reconciliationReason', 'reconciliationRequired', 'reconciledAt', 'staleAt', 'recoveryReason', 'failureCode', 'providerCode']) {
    assert.equal(Object.hasOwn(retry.record, field), false, field);
  }
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

test('ledger reads reject a final-path inode swap after the handle-bound read', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-path-swap-');
  const stateDir = path.join(root, 'state');
  const ledger = new SubmissionLedger({ stateDir });
  await ledger.begin({ requestId: 'path-swap', kind: 'agents.create', digest });
  const ledgerFile = path.join(stateDir, 'submissions.json');
  const displacedFile = path.join(stateDir, 'submissions.displaced.json');

  const probe = await open(ledgerFile, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalReadFile = fileHandlePrototype.readFile;
  let swapped = false;
  fileHandlePrototype.readFile = async function (...arguments_) {
    const contents = await originalReadFile.apply(this, arguments_);
    if (!swapped) {
      swapped = true;
      await rename(ledgerFile, displacedFile);
      await writeFile(ledgerFile, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
    }
    return contents;
  };
  context.after(() => { fileHandlePrototype.readFile = originalReadFile; });

  await assertLedgerError(() => new SubmissionLedger({ stateDir }).lookup('path-swap'), 'ledger_permissions');
  assert.equal(swapped, true);
  fileHandlePrototype.readFile = originalReadFile;
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

test('a stale ownerless lock is reclaimed only after its age and directory identity remain stable', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-ownerless-stale-');
  const stateDir = path.join(root, 'state');
  await new SubmissionLedger({ stateDir }).init();
  const lockDir = path.join(stateDir, 'submissions.lock');
  await mkdir(lockDir, { mode: 0o700 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const ledger = new SubmissionLedger({ stateDir, lockTimeoutMs: 100, lockRetryMs: 5, lockStaleMs: 1_000 });
  const result = await ledger.begin({ requestId: 'ownerless-stale', kind: 'agents.create', digest });
  assert.equal(result.duplicate, false);
  assert.equal((await ledger.lookup('ownerless-stale')).status, 'pending');
  await ledger.fail('ownerless-stale', { failureCode: 'test-cleanup' });
  await assert.rejects(lstat(lockDir), { code: 'ENOENT' });
});

test('a stale malformed lock owner marker is reclaimable without weakening fresh-lock protection', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-malformed-lock-');
  const stateDir = path.join(root, 'state');
  await new SubmissionLedger({ stateDir }).init();
  const lockDir = path.join(stateDir, 'submissions.lock');
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(path.join(lockDir, 'owner.json'), '{not-json', { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const ledger = new SubmissionLedger({ stateDir, lockTimeoutMs: 100, lockRetryMs: 5, lockStaleMs: 1_000 });
  const result = await ledger.begin({ requestId: 'malformed-stale', kind: 'agents.create', digest });
  assert.equal(result.duplicate, false);
  await ledger.fail('malformed-stale', { failureCode: 'test-cleanup' });
  await assert.rejects(lstat(lockDir), { code: 'ENOENT' });

  const freshLockDir = path.join(stateDir, 'submissions.lock');
  await mkdir(freshLockDir, { mode: 0o700 });
  await writeFile(path.join(freshLockDir, 'owner.json'), '{still-writing', { mode: 0o600 });
  const blocked = new SubmissionLedger({ stateDir, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 60_000 });
  await assertLedgerError(
    () => blocked.begin({ requestId: 'fresh-malformed', kind: 'agents.create', digest }),
    'ledger_lock_timeout',
  );
  assert.equal((await lstat(freshLockDir)).isDirectory(), true);
});

test('independent processes contend on a stale lock without deleting the replacement owner marker', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-independent-lock-race-');
  const stateDir = path.join(root, 'state');
  await new SubmissionLedger({ stateDir }).init();
  const lockDir = path.join(stateDir, 'submissions.lock');
  await mkdir(lockDir, { mode: 0o700 });
  await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: 999_999, createdAt: Date.now() }), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDir, old, old);

  const [first, second] = await Promise.all([
    runLedgerChild(stateDir, 'independent-child-1'),
    runLedgerChild(stateDir, 'independent-child-2'),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  const records = JSON.parse(await readFile(path.join(stateDir, 'submissions.json'), 'utf8')).records;
  assert.deepEqual(records.map((record) => record.requestId).sort(), ['independent-child-1', 'independent-child-2']);
  await assert.rejects(lstat(lockDir), { code: 'ENOENT' });
});

test('state-directory resolution honors explicit and shared configuration before XDG/HOME', async (context) => {
  const root = await stateFixture(context);
  assert.deepEqual(resolveStateDirectory({ CURSOR_CLOUD_CONTROL_STATE_DIR: path.join(root, 'explicit'), HOME: root }), {
    directory: path.join(root, 'explicit'),
    source: 'environment',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({
    CURSOR_CLOUD_CONTROL_STATE_DIR: path.join(root, 'explicit'),
    CODEX_TASK_STATE_ROOT: path.join(root, 'shared'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    HOME: root,
  }), {
    directory: path.join(root, 'explicit'),
    source: 'environment',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ CODEX_TASK_STATE_ROOT: path.join(root, 'shared'), HOME: root }), {
    directory: path.join(root, 'shared', 'cursor-cloud-control'),
    source: 'task_state_root',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ CURSOR_CLOUD_CONTROL_STATE_DIR: '', HOME: root }), {
    directory: null,
    source: 'environment',
    reason: 'CURSOR_CLOUD_CONTROL_STATE_DIR is empty.',
  });
  assert.deepEqual(resolveStateDirectory({ CURSOR_CLOUD_CONTROL_STATE_DIR: 'relative-state', HOME: root }), {
    directory: null,
    source: 'environment',
    reason: 'CURSOR_CLOUD_CONTROL_STATE_DIR must be an absolute path.',
  });
  assert.deepEqual(resolveStateDirectory({ CODEX_TASK_STATE_ROOT: '', HOME: root }), {
    directory: null,
    source: 'task_state_root',
    reason: 'CODEX_TASK_STATE_ROOT is empty.',
  });
  assert.deepEqual(resolveStateDirectory({ CODEX_TASK_STATE_ROOT: 'relative-state', HOME: root }), {
    directory: null,
    source: 'task_state_root',
    reason: 'CODEX_TASK_STATE_ROOT must be an absolute path.',
  });
  assert.deepEqual(resolveStateDirectory({ XDG_STATE_HOME: path.join(root, 'xdg'), HOME: root }), {
    directory: path.join(root, 'xdg', 'cursor-cloud-control'),
    source: 'xdg_state_home',
    reason: null,
  });
  assert.deepEqual(resolveStateDirectory({ XDG_STATE_HOME: 'relative-xdg', HOME: root }), {
    directory: null,
    source: 'xdg_state_home',
    reason: 'XDG_STATE_HOME must be an absolute path.',
  });
  assert.deepEqual(resolveStateDirectory({ HOME: 'relative-home' }), {
    directory: null,
    source: 'home',
    reason: 'HOME must be an absolute path.',
  });
  assert.deepEqual(resolveStateDirectory({}), {
    directory: null,
    source: 'unconfigured',
    reason: 'Set CURSOR_CLOUD_CONTROL_STATE_DIR, CODEX_TASK_STATE_ROOT, or HOME/XDG_STATE_HOME before using Cursor mutations.',
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

test('relative XDG and HOME state roots fail before creating cwd-relative state', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-relative-root-');
  const target = path.join(root, 'cwd-relative-target');
  const relativeTarget = path.relative(process.cwd(), target);

  for (const env of [
    { XDG_STATE_HOME: relativeTarget, HOME: root },
    { XDG_STATE_HOME: '', HOME: relativeTarget },
  ]) {
    const ledger = new SubmissionLedger({ env });
    const readiness = await ledger.readiness();
    assert.equal(readiness.ready, false);
    assert.equal(readiness.code, 'ledger_unavailable');
    assert.match(readiness.reason, /must be an absolute path/);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  }
});

test('shared task state works without HOME and does not fall back from an unsafe root', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-shared-root-');
  const sharedRoot = path.join(root, 'shared');
  const shared = new SubmissionLedger({ env: { CODEX_TASK_STATE_ROOT: sharedRoot } });
  const readiness = await shared.readiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.source, 'task_state_root');
  assert.equal(readiness.directory, path.join(sharedRoot, 'cursor-cloud-control'));
  assert.equal((await lstat(readiness.directory)).mode & 0o777, 0o700);

  const regularFile = path.join(root, 'not-a-directory');
  await writeFile(regularFile, 'x', { mode: 0o600 });
  const unavailable = new SubmissionLedger({ env: { CODEX_TASK_STATE_ROOT: path.join(regularFile, 'child') } });
  const unavailableReadiness = await unavailable.readiness();
  assert.equal(unavailableReadiness.ready, false);
  assert.equal(unavailableReadiness.source, 'task_state_root');
  assert.equal(unavailableReadiness.code, 'ledger_unavailable');
  assert.match(unavailableReadiness.reason, /not-a-directory|unavailable|prepare/i);
});

test('symlinked state directories and symlinked or hardlinked ledger files are rejected', async (context) => {
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

  const hardlinkStateDir = path.join(root, 'hardlink-state');
  const hardlinkTarget = path.join(root, 'hardlink-ledger.json');
  await new SubmissionLedger({ stateDir: hardlinkStateDir }).init();
  await writeFile(hardlinkTarget, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
  await link(hardlinkTarget, path.join(hardlinkStateDir, 'submissions.json'));
  await assertLedgerError(() => new SubmissionLedger({ stateDir: hardlinkStateDir }).lookup('request-1'), 'ledger_permissions');
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

test('non-sticky group/world-writable ancestors are rejected while sticky ancestors are allowed', async (context) => {
  const root = await stateFixture(context, 'cursor-ledger-ancestor-mode-');
  for (const [label, mode] of [['group-writable', 0o770], ['world-writable', 0o777]]) {
    const ancestor = path.join(root, label);
    const stateDir = path.join(ancestor, 'state');
    await mkdir(ancestor, { mode: 0o700 });
    await chmod(ancestor, mode);
    await assertLedgerError(() => new SubmissionLedger({ stateDir }).lookup('request-1'), 'ledger_permissions');
    await assert.rejects(lstat(stateDir), { code: 'ENOENT' });
  }

  const stickyAncestor = path.join(root, 'sticky-world-writable');
  const stickyStateDir = path.join(stickyAncestor, 'state');
  await mkdir(stickyAncestor, { mode: 0o700 });
  await chmod(stickyAncestor, 0o1777);
  const readiness = await new SubmissionLedger({ stateDir: stickyStateDir }).readiness();
  assert.equal(readiness.ready, true);
  assert.equal((await lstat(stickyStateDir)).mode & 0o777, 0o700);
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

test('ledger directory rejects special permission bits even when group/world bits are clear', async (context) => {
  for (const mode of [0o1700, 0o2700, 0o4700]) {
    const root = await stateFixture(context, `cursor-ledger-directory-special-${mode.toString(8)}-`);
    const stateDir = path.join(root, 'state');
    await new SubmissionLedger({ stateDir }).init();
    await chmod(stateDir, mode);
    await assertLedgerError(() => new SubmissionLedger({ stateDir }).lookup('request-1'), 'ledger_permissions');
  }
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
