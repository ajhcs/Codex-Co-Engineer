import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IDENTITY_DOMAIN, IDENTITY_LABELS } from '../mcp/v3/identity.mjs';
import { parseEvidenceBundleV1 } from '../mcp/v3/evidence-bundle.mjs';
import { RunContractV1Error } from '../mcp/v3/run-manifest.mjs';
import {
  CONSTRAINED_VERIFICATION_SCHEMA_ID,
  CONSTRAINED_VERIFICATION_VERSION,
  GIT_EXECUTABLE,
  UNSHARE_EXECUTABLE,
  VERIFICATION_EXECUTION_DIGEST_LABEL,
  executeConstrainedVerificationV1,
} from '../mcp/v3/constrained-verification-runner.mjs';
import {
  SHA_DIFF,
  SHA_INPUT,
  SHA_OUTPUT,
  acceptanceRef,
  payloadDigest,
  reportRef,
  validArtifactRef,
  validBundle,
  validClaim,
  validFact,
  validGitIdentityFact,
} from './fixtures/r1-evidence-fixtures.mjs';
import {
  TRUE_EXECUTABLE,
  fakeChild,
  genuineRequest,
  gitIdentitySnapshot,
  initCandidateRepo,
  makeTempRoot,
  policyForExecutable,
  recordingAdapter,
} from './fixtures/r1-constrained-verification-runner-fixtures.mjs';

function errorOf(action, expectedPath) {
  return Promise.resolve()
    .then(action)
    .then(
      () => assert.fail('expected a typed RunContractV1Error'),
      (error) => {
        assert.ok(error instanceof RunContractV1Error, `expected RunContractV1Error, got ${error}`);
        if (expectedPath !== undefined) assert.equal(error.path, expectedPath);
        return error;
      },
    );
}

async function withHarness(fn, options = {}) {
  const root = await makeTempRoot();
  const candidate = path.join(root, 'candidate');
  const executable = options.executable ?? TRUE_EXECUTABLE;
  try {
    const head = await initCandidateRepo(candidate);
    const policy = options.policy ?? policyForExecutable(executable, options.command ?? {});
    const request = genuineRequest({
      policy,
      executable,
      candidate: {
        repository: candidate,
        expected_head_sha: head,
        expected_base_sha: head,
      },
      selection: options.selection,
    });
    return await fn({ root, candidate, head, request, policy });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('schema identity is additive v1 and does not claim a 4.0.0 major', () => {
  assert.equal(CONSTRAINED_VERIFICATION_SCHEMA_ID,
    'codex-co-engineer.constrained-verification.v1');
  assert.equal(CONSTRAINED_VERIFICATION_VERSION, 1);
  assert.equal(CONSTRAINED_VERIFICATION_SCHEMA_ID.includes('4.0.0'), false);
  assert.equal(VERIFICATION_EXECUTION_DIGEST_LABEL, IDENTITY_LABELS.VERIFICATION_EXECUTION_RECEIPT);
  assert.equal(GIT_EXECUTABLE, '/usr/bin/git');
  assert.equal(UNSHARE_EXECUTABLE, '/usr/bin/unshare');
});

test('a genuine P16B intent executes once with shell=false, empty env, and exact argv', async () => {
  await withHarness(async ({ request, candidate, head }) => {
    const { adapter, calls } = recordingAdapter({
      child: { code: 0, stdout: Buffer.from('PASS\n') },
    });
    const receipt = await executeConstrainedVerificationV1(request, { adapter });
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(receipt.schema, CONSTRAINED_VERIFICATION_SCHEMA_ID);
    assert.equal(receipt.command_id, 'unit-tests');
    assert.equal(receipt.outcome.result, 'pass');
    assert.equal(receipt.outcome.exit_code, 0);
    assert.equal(receipt.outcome.termination, 'exited');
    assert.equal(receipt.outcome.stdout_truncated, false);
    assert.equal(receipt.cleanup.status, 'removed');
    assert.equal(receipt.candidate_audit.unchanged, true);
    assert.equal(receipt.candidate_audit.head_sha, head);
    assert.equal(receipt.execution_identity.domain, IDENTITY_DOMAIN);
    assert.equal(receipt.execution_identity.label, IDENTITY_LABELS.VERIFICATION_EXECUTION_RECEIPT);
    assert.equal(receipt.observations.acceptance.payload.result, 'pass');
    assert.equal(receipt.observations.acceptance.method, 'approved_command_execution');
    assert.equal(receipt.observations.git_identity.method, 'read_only_no_changes');
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0].file, TRUE_EXECUTABLE);
    assert.deepEqual(calls.spawn[0].args, ['ok']);
    assert.equal(calls.spawn[0].options.shell, false);
    assert.deepEqual(calls.spawn[0].options.env, {});
    assert.equal(calls.spawn[0].options.networkMode, 'deny');
    assert.equal(calls.spawn[0].options.cwd === candidate, false);
    assert.equal(Object.isFrozen(request), false);
    assert.throws(() => { receipt.outcome.result = 'fail'; }, TypeError);
  });
});

test('stdout claiming PASS is ignored when the host-observed exit code is non-zero', async () => {
  await withHarness(async ({ request }) => {
    const { adapter } = recordingAdapter({
      child: { code: 1, stdout: Buffer.from('PASS\nall tests passed\n') },
    });
    const receipt = await executeConstrainedVerificationV1(request, { adapter });
    assert.equal(receipt.outcome.result, 'fail');
    assert.equal(receipt.outcome.exit_code, 1);
    assert.equal(receipt.observations.acceptance.payload.result, 'fail');
    assert.equal(JSON.stringify(receipt).includes('PASS'), false);
    assert.equal(JSON.stringify(receipt).includes('all tests passed'), false);
  });
});

test('P13 fact projections compose into an evidence bundle without trusting provider PASS', async () => {
  await withHarness(async ({ request, head }) => {
    const { adapter } = recordingAdapter({ child: { code: 0 } });
    const receipt = await executeConstrainedVerificationV1(request, { adapter });
    const acceptance = receipt.observations.acceptance;
    const git = receipt.observations.git_identity;
    const acceptFact = validFact({
      payload: acceptance.payload,
      payload_digest: acceptance.payload_digest,
      input_digest: SHA_INPUT,
      output_digest: SHA_OUTPUT,
      exit_code: acceptance.exit_code,
      duration_ms: acceptance.duration_ms,
      truncated: false,
      authority: acceptance.authority,
      method: acceptance.method,
    });
    const gitFact = validGitIdentityFact({
      payload: git.payload,
      payload_digest: git.payload_digest,
      method: git.method,
      authority: git.authority,
      artifact_digests: [SHA_DIFF],
    });
    assert.equal(git.payload.head_sha, head);
    const bundle = validBundle({
      repository: { path: request.candidate.repository, base_sha: head },
      candidate: { sha: head },
      claims: [validClaim({ payload: { result: 'pass' }, payload_digest: payloadDigest({ result: 'pass' }) })],
      facts: [acceptFact, gitFact],
      artifacts: [reportRef(), acceptanceRef(), validArtifactRef()],
    });
    const snapshot = parseEvidenceBundleV1(bundle);
    assert.equal(snapshot.final_state, 'pass');
    assert.equal(snapshot.facts[0].method, 'approved_command_execution');
    assert.equal(snapshot.facts[0].payload.result, 'pass');
  });
});

test('provider-reported PASS without a matching host-observed fact cannot be accepted', async () => {
  await withHarness(async ({ request, head }) => {
    const { adapter } = recordingAdapter({ child: { code: 1, stdout: Buffer.from('PASS') } });
    const receipt = await executeConstrainedVerificationV1(request, { adapter });
    const forged = validBundle({
      repository: { path: request.candidate.repository, base_sha: head },
      candidate: { sha: head },
      claims: [validClaim({ payload: { result: 'pass' }, payload_digest: payloadDigest({ result: 'pass' }) })],
      facts: [validFact({
        payload: receipt.observations.acceptance.payload,
        payload_digest: receipt.observations.acceptance.payload_digest,
        exit_code: 1,
      }), validGitIdentityFact({
        payload: receipt.observations.git_identity.payload,
        payload_digest: receipt.observations.git_identity.payload_digest,
      })],
      artifacts: [reportRef(), acceptanceRef(), validArtifactRef()],
    });
    const error = await errorOf(() => parseEvidenceBundleV1(forged));
    assert.ok(
      error.code === 'unproven_accepted_state' || error.code === 'invalid_format',
      error.code,
    );
  });
});

test('policy-authorized env entries are the only child environment and PATH is absent', async () => {
  await withHarness(async ({ request }) => {
    const { adapter, calls } = recordingAdapter({ child: { code: 0 } });
    await executeConstrainedVerificationV1(request, { adapter });
    assert.deepEqual(calls.spawn[0].options.env, { TZ: 'UTC' });
    assert.equal(Object.hasOwn(calls.spawn[0].options.env, 'PATH'), false);
  }, {
    command: {
      environment: { entries: [{ name: 'TZ', value: 'UTC' }] },
    },
  });
});

test('timeout, output flood, signal ambiguity, and escaped descendants fail closed', async () => {
  await withHarness(async ({ request }) => {
    const hanging = recordingAdapter({
      spawn: () => fakeChild({ hang: true, ignoreKill: true, pid: 99 }),
      listDescendants: async () => [],
    });
    const timeoutError = await errorOf(() => executeConstrainedVerificationV1(request, {
      adapter: hanging.adapter,
    }));
    assert.equal(timeoutError.code, 'timeout');

    const flood = recordingAdapter({
      child: { floodBytes: 80, code: 0 },
    });
    const floodError = await errorOf(() => executeConstrainedVerificationV1(request, {
      adapter: flood.adapter,
    }));
    assert.equal(floodError.code, 'output_flood');

    const ambiguous = recordingAdapter({
      child: { code: 0, signal: 'SIGTERM' },
    });
    const ambiguousError = await errorOf(() => executeConstrainedVerificationV1(request, {
      adapter: ambiguous.adapter,
    }));
    assert.equal(ambiguousError.code, 'signal_ambiguous');

    const escaped = recordingAdapter({
      child: { code: 0, pid: 50 },
      listDescendants: async () => [51],
    });
    const escapedError = await errorOf(() => executeConstrainedVerificationV1(request, {
      adapter: escaped.adapter,
    }));
    assert.equal(escapedError.code, 'escaped_descendants');
  }, {
    command: {
      timeout_ms: 1000,
      resources: { max_output_bytes: 16, max_error_bytes: 16 },
    },
  });
});

test('candidate mutation and identity mismatch fail closed without a pass receipt', async () => {
  await withHarness(async ({ request, head }) => {
    let calls = 0;
    const { adapter } = recordingAdapter({
      child: { code: 0 },
      readGitIdentity: async () => {
        calls += 1;
        if (calls === 1) return gitIdentitySnapshot({ head_sha: head, gitdir: `${request.candidate.repository}/.git` });
        return gitIdentitySnapshot({ head_sha: 'cccccccccccccccccccccccccccccccccccccccc', gitdir: `${request.candidate.repository}/.git` });
      },
    });
    const mutated = await errorOf(() => executeConstrainedVerificationV1(request, { adapter }));
    assert.equal(mutated.code, 'candidate_mutated');

    const mismatch = await errorOf(() => executeConstrainedVerificationV1({
      ...request,
      candidate: {
        repository: request.candidate.repository,
        expected_head_sha: 'dddddddddddddddddddddddddddddddddddddddd',
      },
    }, { adapter: recordingAdapter({ child: { code: 0 } }).adapter }));
    assert.equal(mismatch.code, 'candidate_identity_mismatch');
  });
});

test('cleanup refuses broad or swapped paths and still removes the exact workspace', async () => {
  await withHarness(async ({ request, candidate, root }) => {
    const forbidden = [];
    const { adapter, calls } = recordingAdapter({
      child: { code: 0 },
      rmdirExact: async (record) => {
        if (record.path === '/' || record.path === root || record.path === candidate
          || record.path === tmpdir()) {
          forbidden.push(record.path);
          throw new Error('refused broad delete');
        }
        await rm(record.path, { recursive: true, force: false });
      },
    });
    const receipt = await executeConstrainedVerificationV1(request, { adapter });
    assert.equal(receipt.cleanup.status, 'removed');
    assert.equal(calls.rmdir.length, 1);
    assert.equal(calls.rmdir[0].startsWith(path.resolve(tmpdir())), true);
    assert.equal(calls.rmdir[0].includes('codex-co-engineer-p16c-'), true);
    assert.equal(forbidden.length, 0);
    assert.notEqual(calls.rmdir[0], candidate);
    assert.notEqual(calls.rmdir[0], '/');
  });
});

test('default host adapter executes /usr/bin/true under network-deny confinement', async () => {
  await withHarness(async ({ request }) => {
    const receipt = await executeConstrainedVerificationV1(request);
    assert.equal(receipt.outcome.result, 'pass');
    assert.equal(receipt.outcome.exit_code, 0);
    assert.equal(receipt.cleanup.status, 'removed');
    assert.equal(receipt.candidate_audit.unchanged, true);
  });
});

test('the module never shells, looks up PATH, or integrates server/supervisor surfaces', async () => {
  const source = await readFile(
    new URL('../mcp/v3/constrained-verification-runner.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /never consults PATH/u);
  assert.match(source, /never uses a shell/u);
  assert.match(source, /shell: false/u);
  assert.doesNotMatch(source, /from '\.\/server\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/supervisor\.mjs'/u);
  assert.doesNotMatch(source, /from '\.\/process-boundary\.mjs'/u);
  assert.doesNotMatch(source, /from 'node:net'/u);
  assert.doesNotMatch(source, /from 'node:http'/u);
  assert.doesNotMatch(source, /from 'node:dns'/u);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('execSync('), false);
  assert.equal(source.includes("shell: true"), false);
  assert.doesNotMatch(source, /\bgit merge\b/u);
  assert.doesNotMatch(source, /\bgit rebase\b/u);
  assert.doesNotMatch(source, /\bgit push\b/u);
  assert.doesNotMatch(source, /create_pr/u);
});

test('symlinks and special files on the executable or candidate fail closed', async () => {
  const root = await makeTempRoot();
  try {
    const candidate = path.join(root, 'candidate');
    const head = await initCandidateRepo(candidate);
    const link = path.join(root, 'linked-true');
    await symlink(TRUE_EXECUTABLE, link);
    const request = genuineRequest({
      policy: policyForExecutable(link),
      executable: link,
      candidate: { repository: candidate, expected_head_sha: head },
    });
    const error = await errorOf(() => executeConstrainedVerificationV1(request, {
      adapter: recordingAdapter({ child: { code: 0 } }).adapter,
    }));
    assert.equal(error.code, 'symlink_denied');

    const fifoCandidate = path.join(root, 'fifo-cand');
    await writeFile(fifoCandidate, 'not-a-repo\n');
    const fileRequest = genuineRequest({
      policy: policyForExecutable(TRUE_EXECUTABLE),
      executable: TRUE_EXECUTABLE,
      candidate: { repository: fifoCandidate },
    });
    const notDir = await errorOf(() => executeConstrainedVerificationV1(fileRequest, {
      adapter: recordingAdapter({ child: { code: 0 } }).adapter,
    }));
    assert.equal(notDir.code, 'candidate_not_regular');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the approved command is spawned exactly once per invocation', async () => {
  await withHarness(async ({ request }) => {
    const { adapter, calls } = recordingAdapter({ child: { code: 0 } });
    await executeConstrainedVerificationV1(request, { adapter });
    assert.equal(calls.spawn.length, 1);
    assert.equal(calls.spawn[0].file, TRUE_EXECUTABLE);
  });
});
