import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAdmissionUsageLedgerV1 } from '../mcp/v3/admission-usage.mjs';
import { createRunAdmissionRuntime } from '../mcp/v3/run-admission.mjs';
import { compileRunRequestV1 } from '../mcp/v3/run-request-compiler.mjs';
import { createRunToolAdapter, SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX } from '../mcp/v3/run-tool-adapter.mjs';
import { createAdapter } from './fixtures/r1-run-tool-adapter-fixtures.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const timestamp = '2026-09-10T10:00:00.000Z';

function harness(providerResult = 'Provider says PASS. Private /home/test-user/source omitted from shareable report.') {
  const records = new Map();
  let saves = 0;
  const dependencies = {
    compile: request => compileRunRequestV1(request, {
      observeGit: async () => ({ base_sha: base, head_sha: base, tree_sha: 'c'.repeat(40),
        branch: 'main', clean: true, remote_present: true, remote_count: 1 }),
    }),
    clock: () => timestamp,
    requestConsent: async () => ({ approved: true }),
    providerReady: async () => ({ ready: true }),
    processBoundaryReady: async () => ({ ready: true }),
    verifyRepository: async () => ({ verified: true }),
    prepareWorkspace: async ({ assignment }) => ({ prepared: true, workspace: {
      worktree_path: `/private/${assignment.assignment_id}`, branch: 'candidate', start_sha: base,
    } }),
    createSession: async () => ({ ready: true, session_id: 'session' }),
    dispatchPrompt: async () => ({ dispatched: true, confidence: 'authoritative' }),
    inspectLane: async () => ({ status: 'completed', result: providerResult }),
    inspectWorkspace: async () => ({ current_head: head, clean: true, changed_files: [], commits: [head] }),
    verifyRun: async () => ({ verified: true }),
    persistRecord: async record => { records.set(record.run_id, JSON.parse(JSON.stringify(record))); saves += 1; },
    loadRecord: async runId => records.has(runId) ? structuredClone(records.get(runId)) : null,
  };
  function adapter() {
    return createRunToolAdapter({
      runtime: createAdapter().runtime,
      simpleRuntime: createRunAdmissionRuntime(dependencies),
    });
  }
  return { adapter, saves: () => saves };
}

function metric(report, key) {
  return report.usage.metrics.find(row => row.key === key);
}

test('normal run tools expose ledger evidence, preserve unknown usage, and survive restart without double counting', async () => {
  const state = harness();
  const adapter = state.adapter();
  const submitted = await adapter.dispatch('delegate', { run_request: {
    run_id: 'ordinary-evidence', repo: '/private/repository', objective: 'Implement and independently investigate two separate slices.',
    assignments: [
      { assignment_id: 'implementation', provider: 'grok', role: 'implement', prompt: 'Implement the slice.', write_scope: ['src/**'] },
      { assignment_id: 'investigation', provider: 'cursor-local', role: 'review', prompt: 'Investigate the separate concern.' },
    ],
  } });
  assert.equal(submitted.result_evidence.view, 'summary');
  assert.equal(submitted.result_evidence.codex_accepted, false);
  assert.equal(metric(submitted.result_evidence, 'submissions').value, 1);

  const completed = await adapter.dispatch('task', { run_id: submitted.run_id });
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.result_evidence.codex_accepted, false);
  assert.equal(completed.result_evidence.review_needed, true);
  const detail = await adapter.dispatch('task', { run_id: submitted.run_id, view: 'diagnostics' });
  assert.equal(detail.result_evidence.view, 'detail');
  assert.equal(metric(detail.result_evidence, 'submissions').value, 1);
  assert.equal(metric(detail.result_evidence, 'provider_invocations').value, 2);
  assert.equal(metric(detail.result_evidence, 'input_tokens').value, null);
  assert.equal(metric(detail.result_evidence, 'tool_calls').value, null);
  assert.equal(detail.result_evidence.usage.native_tokens, 'unknown');
  assert.doesNotMatch(JSON.stringify(detail.result_evidence), /\/home\/test-user|\/private|Provider says PASS/);

  const before = state.saves();
  const repeated = await adapter.dispatch('task', { run_id: submitted.run_id, view: 'diagnostics' });
  const restarted = await state.adapter().dispatch('task', { run_id: submitted.run_id, view: 'diagnostics' });
  assert.deepEqual(repeated.result_evidence.usage, detail.result_evidence.usage);
  assert.deepEqual(restarted.result_evidence.usage, detail.result_evidence.usage);
  assert.equal(state.saves(), before, 'read-only final evidence must not rewrite state');
});

test('unacknowledged failed dispatch is unknown rather than free or a proven invocation', () => {
  const record = {
    run_id: 'uncertain-usage', updated_at: timestamp, telemetry: { attention_count: 0 },
    lanes: [
      { assignment_id: 'known-worker', provider: 'grok', model: 'grok-4', prompt_attempted: true, prompt_dispatched: true, dispatch_confidence: 'authoritative' },
      { assignment_id: 'failed-worker', provider: 'cursor-local', model: 'composer-1', prompt_attempted: true, prompt_dispatched: false, dispatch_confidence: 'uncertain', phase: 'failed' },
    ],
  };
  const ledger = projectAdmissionUsageLedgerV1(record);
  assert.equal(ledger.totals.host_usage.submissions.value, 1);
  assert.equal(ledger.totals.host_usage.provider_invocations.value, null);
  assert.equal(ledger.totals.host_usage.provider_invocations.reported_sum, 1);
  assert.equal(ledger.totals.host_usage.provider_invocations.unknown_count, 1);
  assert.equal(ledger.totals.provider_usage.output_tokens.value, null);
  assert.equal(ledger.totals.host_usage.elapsed_ms.value, null);
  assert.equal(ledger.receipts.length, 2);
  assert.doesNotMatch(JSON.stringify(ledger), /uncertain-usage|known-worker|failed-worker|composer-1/);
});

test('eight real admission lanes keep result evidence inside the status transport cap', async () => {
  const state = harness('Large provider result. '.repeat(2000));
  const adapter = state.adapter();
  const runId = `maximum-${'a'.repeat(55)}`;
  await adapter.dispatch('delegate', { run_request: {
    run_id: runId, repo: '/private/repository', objective: 'Eight independent bounded implementations.',
    assignments: Array.from({ length: 8 }, (_, index) => ({
      assignment_id: `lane-${index}-${'a'.repeat(56)}`, provider: index % 2 ? 'cursor-local' : 'grok',
      role: 'implement', prompt: 'Implement this independent slice.', write_scope: [`src/lane-${index}/**`],
    })),
  } });
  for (const view of ['compact', 'diagnostics']) {
    const reply = await adapter.dispatch('task', { run_id: runId, view });
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= SIMPLE_RUN_STATUS_STRUCTURED_BYTES_MAX);
    assert.equal(reply.result_evidence.codex_accepted, false);
    assert.equal(reply.result_evidence.assignment_result, 'completed');
  }
});

test('ordinary adapter results require explicit clean proof and dirty proof wins', async () => {
  async function complete(runId, workspace, buildHandoff) {
    const records = new Map();
    const dependencies = {
      compile: request => compileRunRequestV1(request, {
        observeGit: async () => ({ base_sha: base, head_sha: base, tree_sha: 'c'.repeat(40),
          branch: 'main', clean: true, remote_present: true, remote_count: 1 }),
      }),
      clock: () => timestamp,
      requestConsent: async () => ({ approved: true }),
      providerReady: async () => ({ ready: true }),
      processBoundaryReady: async () => ({ ready: true }),
      verifyRepository: async () => ({ verified: true }),
      prepareWorkspace: async ({ assignment }) => ({ prepared: true, workspace: {
        worktree_path: `/private/${assignment.assignment_id}`, branch: 'candidate', start_sha: base,
      } }),
      createSession: async () => ({ ready: true, session_id: 'session' }),
      dispatchPrompt: async () => ({ dispatched: true, confidence: 'authoritative' }),
      inspectLane: async () => ({ status: 'completed', result: 'done' }),
      inspectWorkspace: async () => ({ ...workspace }),
      ...(buildHandoff ? { buildHandoff } : {}),
      verifyRun: async () => ({ verified: true }),
      persistRecord: async record => { records.set(record.run_id, JSON.parse(JSON.stringify(record))); },
      loadRecord: async runIdValue => records.has(runIdValue) ? structuredClone(records.get(runIdValue)) : null,
    };
    const adapter = createRunToolAdapter({
      runtime: createAdapter().runtime,
      simpleRuntime: createRunAdmissionRuntime(dependencies),
    });
    await adapter.dispatch('delegate', { run_request: {
      run_id: runId, repo: '/private/repository', objective: 'Implement one bounded slice.',
      assignments: [{
        assignment_id: 'implementation', provider: 'grok', role: 'implement',
        prompt: 'Implement the slice.', write_scope: ['src/**'],
      }],
    } });
    return adapter.dispatch('task', { run_id: runId, view: 'diagnostics' });
  }

  const clean = await complete('ordinary-clean', {
    current_head: head, clean: true, changed_files: [], commits: [head],
  });
  assert.equal(clean.result_evidence.assignment_result, 'completed');
  assert.equal(clean.result_evidence.assignments[0].outcome, 'completed');

  const dirty = await complete('ordinary-dirty', {
    current_head: head, clean: false, changed_files: ['src/a.js'], commits: [head],
  });
  assert.equal(dirty.result_evidence.assignment_result, 'uncertain');
  assert.equal(dirty.result_evidence.assignments[0].outcome, 'uncertain');

  const unknown = await complete('ordinary-unknown', {
    current_head: head, changed_files: [], commits: [head],
  });
  assert.equal(unknown.result_evidence.assignment_result, 'uncertain');
  assert.equal(unknown.result_evidence.assignments[0].outcome, 'uncertain');

  const conflict = await complete('ordinary-conflict', {
    current_head: head, clean: true, changed_files: [], commits: [head],
  }, async ({ fallback }) => ({ ...fallback, clean: false }));
  assert.equal(conflict.result_evidence.assignment_result, 'uncertain');
  assert.equal(conflict.result_evidence.assignments[0].outcome, 'uncertain');
});
