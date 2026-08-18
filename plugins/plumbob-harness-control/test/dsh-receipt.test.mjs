import assert from 'node:assert/strict';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __testing,
  DSH_RECEIPT_MAX_BYTES,
  DshReceiptError,
  createDshReceiptReader,
  secureReceiptPlatformAvailable,
  validateDshJobId,
} from '../mcp/dsh-receipt.mjs';

const OBSERVED_AT = '2026-08-17T00:00:00.000Z';
const DEFAULT_JOB_ID = 'deepseek-agent-20260817000000-abcdef12';

function jobId(sequence = 1) {
  return `deepseek-agent-20260817000000-${sequence.toString(16).padStart(8, '0')}`;
}

function terminalJob(id = DEFAULT_JOB_ID, extra = {}) {
  return {
    id,
    kind: 'deepseek_agent',
    status: 'succeeded',
    lifecycle_state: 'completed',
    ...extra,
  };
}

function receipt(extra = {}) {
  return {
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    jobId: DEFAULT_JOB_ID,
    rootSessionId: 'session-root-1',
    observedAt: OBSERVED_AT,
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 35,
    },
    ...extra,
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-receipt-'));
  const jobsDir = path.join(root, 'jobs');
  await mkdir(jobsDir, { mode: 0o700 });
  await chmod(jobsDir, 0o700);
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, jobsDir };
}

async function putReceipt(jobsDir, jobId, value, options = {}) {
  const encoded = options.raw ?? `${JSON.stringify(value)}\n`;
  await writeFile(path.join(jobsDir, `${jobId}.usage.json`), encoded, { mode: 0o600 });
  await chmod(path.join(jobsDir, `${jobId}.usage.json`), options.mode ?? 0o600);
}

function readerFor(jobsDir, job) {
  return createDshReceiptReader({
    jobsDir,
    loadJob: async (selectedId) => selectedId === job.id ? job : null,
  });
}

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof DshReceiptError, true);
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.equal(error.message.length <= 160, true);
    return true;
  });
}

test('validates the exact lower-case managed job-id grammar', () => {
  assert.equal(validateDshJobId(DEFAULT_JOB_ID), DEFAULT_JOB_ID);
  assert.throws(() => validateDshJobId('short'), (error) => error.code === 'invalid_job_id');
  assert.throws(() => validateDshJobId('Dsh-job-1'), (error) => error.code === 'invalid_job_id');
  assert.throws(() => validateDshJobId('dsh/job-1'), (error) => error.code === 'invalid_job_id');
  assert.throws(() => validateDshJobId(`dsh-${'x'.repeat(93)}`), (error) => error.code === 'invalid_job_id');
});

test('uses the injected managed-store lookup and binds its result to the selected ID', async (context) => {
  const { jobsDir } = await fixture(context);
  const selected = jobId(20);
  await putReceipt(jobsDir, selected, receipt({ jobId: selected }));
  const calls = [];
  const reader = createDshReceiptReader({
    jobsDir,
    loadJob: async (id) => {
      calls.push(id);
      return terminalJob(jobId(21));
    },
  });
  await assertCode(reader(selected), 'job_identity_mismatch');
  assert.deepEqual(calls, [selected]);

  await assertCode(createDshReceiptReader({
    jobsDir,
    loadJob: async (id) => terminalJob(id, { kind: 'grok_build' }),
  })(selected), 'wrong_job_kind');
  await assertCode(createDshReceiptReader({
    jobsDir,
    loadJob: async (id) => terminalJob(id, { lifecycle_state: 'working', status: 'running' }),
  })(selected), 'job_not_terminal');
  await assertCode(reader('invalid/id'), 'invalid_job_id');
});

test('requires the canonical receipt jobId and exact selected job identity', async (context) => {
  const { jobsDir } = await fixture(context);
  const selected = jobId(22);
  const reader = readerFor(jobsDir, terminalJob(selected));
  await putReceipt(jobsDir, selected, receipt({ jobId: undefined }));
  await assertCode(reader(selected), 'receipt_identity_missing');
  await putReceipt(jobsDir, selected, receipt({ jobId: selected }));
  const valid = await reader(selected);
  assert.equal(valid.counts.totalTokens, 35);
  await putReceipt(jobsDir, selected, receipt({ jobId: jobId(23) }));
  await assertCode(reader(selected), 'receipt_identity_mismatch');
  const missing = receipt({ jobId: selected });
  delete missing.jobId;
  await putReceipt(jobsDir, selected, missing);
  await assertCode(reader(selected), 'receipt_identity_missing');
});

test('exposes a fail-closed platform guard for required POSIX primitives', () => {
  assert.equal(secureReceiptPlatformAvailable(), true);
  assert.equal(secureReceiptPlatformAvailable({ constants: {}, getuid: () => 0 }), false);
  assert.equal(secureReceiptPlatformAvailable({ constants: { O_NOFOLLOW: 1 }, getuid: undefined }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'linux',
  }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_DIRECTORY: 2, O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'darwin',
  }), false);
  assert.equal(secureReceiptPlatformAvailable({
    constants: { O_DIRECTORY: 2, O_NOFOLLOW: 1 },
    getuid: () => 0,
    platform: 'linux',
  }), true);
});

test('reads one exact terminal DSH receipt and strips prompt/cost/provider fields', async (context) => {
  const { jobsDir } = await fixture(context);
  const job = terminalJob();
  await putReceipt(jobsDir, job.id, receipt({
    jobId: job.id,
    sessionId: 'session-root-1',
    prompt: 'do not expose this',
    estimatedCost: 42,
    spend: { usd: 42 },
    accountRemaining: 0,
    rateLimit: { remaining: 0 },
    model: 'muse-spark-1.2-contributor',
    models: ['muse-spark-1.2-contributor'],
  }));

  const result = await readerFor(jobsDir, job)(job.id);
  assert.deepEqual(result, {
    schemaVersion: 1,
    source: 'dsh-headless-live',
    scope: 'task',
    rootSessionId: 'session-root-1',
    observedAt: OBSERVED_AT,
    aggregationComplete: true,
    confidence: 'exact',
    usageSamples: 1,
    counts: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 35,
    },
  });
  assert.equal(JSON.stringify(result).includes('prompt'), false);
  assert.equal(JSON.stringify(result).includes('estimatedCost'), false);
  assert.equal(JSON.stringify(result).includes('muse'), false);
});

test('descriptor-anchors receipt reads across a parent-directory swap', async (context) => {
  const { root, jobsDir } = await fixture(context);
  const selected = jobId(24);
  const movedJobs = path.join(root, 'moved-jobs');
  await putReceipt(jobsDir, selected, receipt({ jobId: selected }));
  const reader = __testing.createDshReceiptReaderWithHooks({
    jobsDir,
    loadJob: async (id) => terminalJob(id),
  }, {
    afterParentOpen: async () => {
      await rename(jobsDir, movedJobs);
      await mkdir(jobsDir, { mode: 0o700 });
      await chmod(jobsDir, 0o700);
    },
  });

  // An unanchored reader would report receipt_missing from the empty
  // replacement directory. The anchored reader consumes only the old inode,
  // then fails because the administrator-selected path changed identity.
  await assertCode(reader(selected), 'jobs_dir_replaced');
  assert.deepEqual(await readdir(jobsDir), []);
  assert.deepEqual(await readdir(movedJobs), [`${selected}.usage.json`]);
});

test('accepts a status-only terminal row and rejects active or non-DSH rows', async (context) => {
  const { jobsDir } = await fixture(context);
  const id = jobId(2);
  await putReceipt(jobsDir, id, receipt({ jobId: id }));
  const statusOnlyJob = terminalJob(id, { lifecycle_state: undefined });
  const reader = readerFor(jobsDir, statusOnlyJob);
  const statusOnly = await reader(id);
  assert.equal(statusOnly.counts.totalTokens, 35);
  await assertCode(readerFor(jobsDir, terminalJob(id, { lifecycle_state: 'working', status: 'running' }))(id), 'job_not_terminal');
  await assertCode(readerFor(jobsDir, { ...terminalJob(id), kind: 'grok_build' })(id), 'wrong_job_kind');
});

test('missing, malformed, and inconsistent receipts never become zero usage', async (context) => {
  const { jobsDir } = await fixture(context);
  const job = terminalJob(jobId(3));
  const reader = readerFor(jobsDir, job);
  await assertCode(reader(job.id), 'receipt_missing');

  await putReceipt(jobsDir, job.id, null, { raw: '{not-json}\n' });
  await assertCode(reader(job.id), 'invalid_json');

  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id, counts: { ...receipt().counts, totalTokens: 0 } }));
  await assertCode(reader(job.id), 'invalid_receipt');
});

test('enforces trusted source, scope, session identity, and optional job identity', async (context) => {
  const { jobsDir } = await fixture(context);
  const job = terminalJob(jobId(4));
  const reader = readerFor(jobsDir, job);
  const cases = [
    [{ source: 'other' }, 'invalid_receipt'],
    [{ scope: 'account' }, 'invalid_receipt'],
    [{ session_id: 'other-session' }, 'receipt_identity_mismatch'],
    [{ jobId: jobId(5) }, 'receipt_identity_mismatch'],
    [{ job_id: 'invalid/id' }, 'invalid_job_id'],
  ];
  for (const [changes, code] of cases) {
    await putReceipt(jobsDir, job.id, receipt({ jobId: job.id, ...changes }));
    await assertCode(reader(job.id), code);
  }
  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id, job_id: job.id }));
  const valid = await reader(job.id);
  assert.equal(valid.counts.totalTokens, 35);
});

test('enforces confidence/sample and safe integer invariants', async (context) => {
  const { jobsDir } = await fixture(context);
  const job = terminalJob(jobId(5));
  const reader = readerFor(jobsDir, job);
  const invalid = [
    { aggregationComplete: true, confidence: 'observed' },
    { aggregationComplete: false, confidence: 'exact' },
    { confidence: 'exact', usageSamples: 0 },
    { confidence: 'unknown', usageSamples: 1 },
    { confidence: 'unknown', counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1 } },
    { counts: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER } },
    { counts: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, totalTokens: 9 } },
  ];
  for (const changes of invalid) {
    await putReceipt(jobsDir, job.id, receipt({ jobId: job.id, ...changes }));
    await assertCode(reader(job.id), 'invalid_receipt');
  }

  await putReceipt(jobsDir, job.id, receipt({
    jobId: job.id,
    aggregationComplete: false,
    confidence: 'observed',
  }));
  const partial = await reader(job.id);
  assert.equal(partial.aggregationComplete, false);
  assert.equal(partial.confidence, 'observed');

  await putReceipt(jobsDir, job.id, receipt({
    jobId: job.id,
    aggregationComplete: true,
    confidence: 'unknown',
    usageSamples: 0,
    counts: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  }));
  const unknown = await reader(job.id);
  assert.equal(unknown.counts.totalTokens, 0);
  assert.equal(unknown.confidence, 'unknown');
});

test('rejects symlinked, nonregular, permissive, and oversized receipt files', async (context) => {
  const { root, jobsDir } = await fixture(context);
  const job = terminalJob(jobId(6));
  const reader = readerFor(jobsDir, job);
  const target = path.join(root, 'outside.json');
  await writeFile(target, JSON.stringify(receipt()), { mode: 0o600 });
  await symlink(target, path.join(jobsDir, `${job.id}.usage.json`));
  await assertCode(reader(job.id), 'receipt_symlink');

  await rm(path.join(jobsDir, `${job.id}.usage.json`));
  await mkdir(path.join(jobsDir, `${job.id}.usage.json`), { mode: 0o700 });
  await assertCode(reader(job.id), 'receipt_not_regular');

  await rm(path.join(jobsDir, `${job.id}.usage.json`), { recursive: true });
  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }), { mode: 0o644 });
  await assertCode(reader(job.id), 'receipt_permissions');
  await rm(path.join(jobsDir, `${job.id}.usage.json`));

  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }), { mode: 0o400 });
  await assertCode(reader(job.id), 'receipt_permissions');
  await rm(path.join(jobsDir, `${job.id}.usage.json`));

  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }), { mode: 0o700 });
  await assertCode(reader(job.id), 'receipt_permissions');
  await rm(path.join(jobsDir, `${job.id}.usage.json`));

  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }), { mode: 0o4600 });
  await assertCode(reader(job.id), 'receipt_permissions');
  await rm(path.join(jobsDir, `${job.id}.usage.json`));

  await putReceipt(jobsDir, job.id, null, {
    raw: `${'x'.repeat(DSH_RECEIPT_MAX_BYTES + 1)}\n`,
  });
  await assertCode(reader(job.id), 'receipt_too_large');
});

test('rejects a receipt with more than one directory link', async (context) => {
  const { root, jobsDir } = await fixture(context);
  const job = terminalJob(jobId(9));
  const reader = readerFor(jobsDir, job);
  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }));
  await link(
    path.join(jobsDir, `${job.id}.usage.json`),
    path.join(root, 'receipt-hardlink.json'),
  );
  await assertCode(reader(job.id), 'receipt_hardlink');
});

test('rejects symlinked or permissive jobs directories and invalid reader options', async (context) => {
  const { root, jobsDir } = await fixture(context);
  assert.throws(() => createDshReceiptReader({ jobsDir: 'relative/jobs', loadJob: async () => null }), (error) => error.code === 'invalid_options');
  assert.throws(() => createDshReceiptReader({ jobsDir }), (error) => error.code === 'invalid_options');
  const job = terminalJob(jobId(7));
  await putReceipt(jobsDir, job.id, receipt({ jobId: job.id }));

  const linked = path.join(root, 'linked-jobs');
  await symlink(jobsDir, linked);
  await assertCode(readerFor(linked, job)(job.id), 'jobs_dir_symlink');
  await chmod(jobsDir, 0o755);
  await assertCode(readerFor(jobsDir, job)(job.id), 'jobs_dir_permissions');
  await chmod(jobsDir, 0o1700);
  await assertCode(readerFor(jobsDir, job)(job.id), 'jobs_dir_permissions');
});

test('rejects invalid UTF-8 before JSON parsing', async (context) => {
  const { jobsDir } = await fixture(context);
  const job = terminalJob(jobId(8));
  const reader = readerFor(jobsDir, job);
  await putReceipt(jobsDir, job.id, null, { raw: Buffer.from([0xc3, 0x28]) });
  await assertCode(reader(job.id), 'receipt_encoding');
});
