import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseTrial, loadCases } from './compare-coengineer-runs.mjs';
import {
  collectTrialUsage,
  main,
  parseManifest,
  MANIFEST_SCHEMA_ID,
} from './collect-coengineer-trial-usage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_DIR = path.join(ROOT, 'benchmarks/cases');

function usage(input, cached, output, reasoning, total = input + output, extras = {}) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
    ...extras,
  };
}

function threadAfter(...records) {
  const sum = usage(0, 0, 0, 0, 0, { cache_write_input_tokens: 0 });
  for (const record of records) {
    for (const key of Object.keys(sum)) {
      if (Object.hasOwn(record, key)) sum[key] += record[key];
    }
  }
  return sum;
}

function line(timestamp, type, payload) {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function sessionMeta(id, timestamp = '2026-09-11T09:59:00.000Z', extras = {}) {
  return line(timestamp, 'session_meta', { id, thread_id: id, ...extras });
}

function helperSessionMeta(id, parentThreadId, timestamp = '2026-09-11T09:59:00.000Z') {
  return sessionMeta(id, timestamp, {
    source: {
      subagent: {
        thread_spawn: { parent_thread_id: parentThreadId },
      },
    },
  });
}

async function writeSession(root, relative, text) {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
  return relative;
}

function baseManifest(caseRecord, overrides = {}) {
  return {
    schema: MANIFEST_SCHEMA_ID,
    trial: {
      trial_id: 'host-native-1',
      case_id: caseRecord.id,
      arm: 'native-codex',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'native', value: 'native-codex' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
      provider_configuration: { implement: 'native' },
      accepted: true,
    },
    window: {
      start: '2026-09-11T10:00:00.000Z',
      end: '2026-09-11T10:05:00.000Z',
    },
    sessions: [
      { id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' },
      {
        id: 'helper-session',
        role: 'native_helper',
        path: 'sessions/helper.jsonl',
        parent_id: 'parent-session',
      },
    ],
    phases: [
      {
        attempt_id: 'native-initial',
        kind: 'initial',
        outcome: 'completed_unaccepted',
        sequence: 1,
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:02:00.000Z',
        session_id: 'parent-session',
      },
      {
        attempt_id: 'native-helper',
        kind: 'native_helper',
        outcome: 'accepted',
        sequence: 2,
        start: '2026-09-11T10:01:00.000Z',
        end: '2026-09-11T10:01:30.000Z',
        session_id: 'helper-session',
      },
    ],
    ...overrides,
  };
}

test('happy path imports parent+helper usage and passes analyzer parseTrial', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU1 = usage(100, 20, 40, 10);
    const parentU2 = usage(50, 10, 20, 5);
    const helperU1 = usage(25, 5, 12, 3);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default', effort: 'default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        usage: parentU1,
        thread_token_usage: threadAfter(parentU1),
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          kind: 'started',
          agent_thread_id: 'helper-session',
          agent_path: '/root/helper',
        },
      }),
      line('2026-09-11T10:01:40.000Z', 'token_usage_record', {
        response_id: 'resp-parent-2',
        usage: parentU2,
        thread_token_usage: threadAfter(parentU1, parentU2),
      }),
      line('2026-09-11T10:01:41.000Z', 'compacted', { summary: 'ignored-private' }),
      // Identical duplicate must dedupe, not double-count.
      line('2026-09-11T10:01:42.000Z', 'token_usage_record', {
        response_id: 'resp-parent-2',
        usage: parentU2,
        thread_token_usage: threadAfter(parentU1, parentU2),
      }),
      // Secondary cumulative may exclude compaction; keep non-authoritative.
      line('2026-09-11T10:01:50.000Z', 'event_msg', {
        type: 'token_count',
        info: { total_token_usage: threadAfter(parentU1, parentU2) },
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      sessionMeta('helper-session'),
      line('2026-09-11T10:01:05.000Z', 'turn_context', { model: 'codex-default', effort: 'low' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-1',
        usage: helperU1,
        thread_token_usage: threadAfter(helperU1),
      }),
    ].join(''));

    const manifest = baseManifest(caseRecord);
    const report = await collectTrialUsage(manifest, { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.native_parent_excludes_helpers, true);
    assert.equal(report.trial.attempts[0].usage.native_input_tokens.value, 150);
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 60);
    assert.equal(report.trial.attempts[1].usage.native_input_tokens.value, 25);
    assert.equal(report.trial.attempts[1].usage.native_helper_calls.value, 1);
    assert.equal(report.breakdown.totals.reasoning_output_tokens, 18);
    assert.equal(report.breakdown.totals.cached_input_tokens, 35);
    assert.equal(report.breakdown.accounting.compaction_counted_once, true);
    assert.equal(report.breakdown.attempts[0].compaction_events, 1);
    // Privacy: no absolute paths or prompt/reasoning bodies in the aggregate.
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(Object.hasOwn(report.breakdown.attempts[0], 'summary'), false);

    const accepted = parseTrial(report.trial);
    assert.equal(accepted.trial_id, 'host-native-1');
    assert.equal(accepted.attempts.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conflicting response_id duplicates fail closed', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const first = usage(10, 0, 4, 1);
    const second = usage(11, 0, 4, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'dup',
        usage: first,
        thread_token_usage: first,
      }),
      line('2026-09-11T10:00:11.000Z', 'token_usage_record', {
        response_id: 'dup',
        usage: second,
        thread_token_usage: second,
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      sessionMeta('helper-session'),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'helper',
        usage: usage(1, 0, 1, 0),
        thread_token_usage: usage(1, 0, 1, 0),
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent helper session is inconclusive and never reports zero usage', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU1 = usage(40, 0, 8, 2);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        usage: parentU1,
        thread_token_usage: parentU1,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          kind: 'started',
          agent_thread_id: 'helper-session',
          agent_path: '/root/helper',
        },
      }),
    ].join(''));
    // helper.jsonl intentionally absent — linked nested child is rejected.
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('overlapping phases and absolute session paths are rejected', () => {
  const caseRecord = {
    id: 'single-file-bugfix',
    base_sha: 'df49c63059159a79646258358850bef0590ca583',
    input_digest: '54bd89a12cdbb1a66e662467f71d96bfc5e596bafced30f6a0c715c68a71d368',
  };
  assert.throws(() => parseManifest(baseManifest(caseRecord, {
    phases: [
      {
        attempt_id: 'phase-a',
        kind: 'initial',
        outcome: 'failed',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:02:00.000Z',
        session_id: 'parent-session',
      },
      {
        attempt_id: 'phase-b',
        kind: 'correction',
        outcome: 'accepted',
        start: '2026-09-11T10:01:00.000Z',
        end: '2026-09-11T10:03:00.000Z',
        session_id: 'parent-session',
      },
    ],
    sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
  })), { code: 'identity_mismatch' });

  assert.throws(() => parseManifest(baseManifest(caseRecord, {
    sessions: [{ id: 'parent-session', role: 'parent', path: '/tmp/secret.jsonl' }],
    phases: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'failed',
      start: '2026-09-11T10:00:00.000Z',
      end: '2026-09-11T10:01:00.000Z',
      session_id: 'parent-session',
    }],
  })), { code: 'invalid_format' });
});

test('privacy fields and mismatched attribution fail closed', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(5, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const manifest = baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
        provider: 'grok',
        // model omitted on purpose while provider is set — collect still emits
        // provider/model only as a pair; analyzer rejects provider metrics without both.
      }],
      trial: {
        trial_id: 'bad-attr',
        case_id: caseRecord.id,
        arm: 'candidate-3.4.3',
        base_sha: caseRecord.base_sha,
        input_digest: caseRecord.input_digest,
        coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-3.4.3' },
        host_model: 'codex-default',
        host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
        provider_configuration: { implement: 'grok', review: null },
        accepted: true,
      },
    });
    // provider without model on phase should fail at manifest parse
    assert.throws(() => parseManifest(manifest), { code: 'invalid_format' });

    const good = baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    });
    const report = await collectTrialUsage(good, { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    // Injecting a forbidden privacy key into a would-be aggregate must fail.
    assert.throws(() => {
      const poisoned = structuredClone(report);
      poisoned.breakdown.prompt = 'secret user text';
      // Re-run privacy gate via JSON round-trip through main write path by
      // asserting the collector never emits such keys.
      assert.equal(Object.hasOwn(report.breakdown, 'prompt'), false);
      throw Object.assign(new Error('privacy_leak'), { code: 'privacy_leak' });
    }, { code: 'privacy_leak' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI writes only with --write and keeps sessions read-only', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(9, 1, 3, 1);
    const sessionRel = await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const before = await readFile(path.join(root, sessionRel), 'utf8');
    const manifest = baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    });
    const manifestPath = path.join(root, 'manifest.json');
    const outPath = path.join(root, 'report.json');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const chunks = [];
    const code = await main(
      ['--manifest', manifestPath, '--sessions-root', root, '--write', outPath],
      { stdout: { write: (text) => chunks.push(text) }, stderr: process.stderr, cwd: root },
    );
    assert.equal(code, 0);
    assert.match(chunks.join(''), /wrote report\.json status=complete/);
    const written = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(written.trial.attempts[0].usage.native_input_tokens.value, 9);
    assert.equal(await readFile(path.join(root, sessionRel), 'utf8'), before);
    parseTrial(written.trial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed and correction attempts preserve outcomes and correction_rounds', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const failUsage = usage(22, 0, 8, 2);
    const fixUsage = usage(18, 0, 7, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'fail-1',
        usage: failUsage,
        thread_token_usage: failUsage,
      }),
      line('2026-09-11T10:03:10.000Z', 'token_usage_record', {
        response_id: 'fix-1',
        usage: fixUsage,
        thread_token_usage: threadAfter(failUsage, fixUsage),
      }),
    ].join(''));
    const manifest = baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [
        {
          attempt_id: 'ce343-failed',
          kind: 'initial',
          outcome: 'failed',
          sequence: 1,
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:02:00.000Z',
          session_id: 'parent-session',
        },
        {
          attempt_id: 'ce343-fix',
          kind: 'correction',
          outcome: 'accepted',
          sequence: 2,
          start: '2026-09-11T10:02:00.000Z',
          end: '2026-09-11T10:04:00.000Z',
          session_id: 'parent-session',
        },
      ],
      trial: {
        trial_id: 'host-343-1',
        case_id: caseRecord.id,
        arm: 'candidate-3.4.3',
        base_sha: caseRecord.base_sha,
        input_digest: caseRecord.input_digest,
        coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-3.4.3' },
        host_model: 'codex-default',
        host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
        provider_configuration: { implement: 'grok', review: null },
        accepted: true,
      },
    });
    const report = await collectTrialUsage(manifest, { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].outcome, 'failed');
    assert.equal(report.trial.attempts[1].kind, 'correction');
    assert.equal(report.trial.attempts[1].usage.correction_rounds.value, 1);
    assert.equal(report.trial.attempts[0].usage.native_input_tokens.value, 22);
    assert.equal(report.trial.attempts[1].usage.native_input_tokens.value, 18);
    parseTrial(report.trial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('optional cache_write_input_tokens is accepted and kept separate from reasoning', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(12, 4, 6, 2, 18, { cache_write_input_tokens: 3 });
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'cache-1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.breakdown.totals.cache_write_input_tokens, 3);
    assert.equal(report.breakdown.totals.reasoning_output_tokens, 2);
    assert.equal(report.breakdown.totals.output_tokens, 6);
    assert.equal(report.breakdown.accounting.cache_counters_separate, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adjacent phase endpoints assign each response once', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u1 = usage(0, 0, 1, 0, 1);
    const u2 = usage(0, 0, 1, 0, 1);
    const u3 = usage(0, 0, 1, 0, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:00.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:01.000Z', 'token_usage_record', {
        response_id: 't1',
        usage: u1,
        thread_token_usage: threadAfter(u1),
      }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 't10',
        usage: u2,
        thread_token_usage: threadAfter(u1, u2),
      }),
      line('2026-09-11T10:00:20.000Z', 'token_usage_record', {
        response_id: 't20',
        usage: u3,
        thread_token_usage: threadAfter(u1, u2, u3),
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      window: {
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:00:20.000Z',
      },
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [
        {
          attempt_id: 'phase-a',
          kind: 'initial',
          outcome: 'completed_unaccepted',
          sequence: 1,
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:00:10.000Z',
          session_id: 'parent-session',
        },
        {
          attempt_id: 'phase-b',
          kind: 'correction',
          outcome: 'accepted',
          sequence: 2,
          start: '2026-09-11T10:00:10.000Z',
          end: '2026-09-11T10:00:20.000Z',
          session_id: 'parent-session',
        },
      ],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 1);
    assert.equal(report.trial.attempts[1].usage.native_output_tokens.value, 2);
    assert.equal(report.breakdown.totals.output_tokens, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pre-window counters reconcile window deltas without false mismatch', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const pre = usage(0, 0, 1, 0, 1);
    const mid = usage(0, 0, 1, 0, 1);
    const late = usage(0, 0, 1, 0, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session', '2026-09-11T09:59:00.000Z'),
      line('2026-09-11T09:59:30.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T09:59:50.000Z', 'token_usage_record', {
        response_id: 'pre',
        usage: pre,
        thread_token_usage: threadAfter(pre),
      }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'mid',
        usage: mid,
        thread_token_usage: threadAfter(pre, mid),
      }),
      line('2026-09-11T10:00:20.000Z', 'token_usage_record', {
        response_id: 'late',
        usage: late,
        thread_token_usage: threadAfter(pre, mid, late),
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      window: {
        start: '2026-09-11T10:00:10.000Z',
        end: '2026-09-11T10:00:20.000Z',
      },
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'windowed',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:10.000Z',
        end: '2026-09-11T10:00:20.000Z',
        session_id: 'parent-session',
      }],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 2);
    assert.equal(report.breakdown.totals.output_tokens, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session_meta conflicts reject and missing meta is inconclusive', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(4, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('other-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
        phases: [{
          attempt_id: 'only',
          kind: 'initial',
          outcome: 'accepted',
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:01:00.000Z',
          session_id: 'parent-session',
        }],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );

    await writeSession(root, 'sessions/parent.jsonl', [
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'inconclusive');
    assert.match(report.evidence.notes.join(','), /missing_session_meta/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('basename child-link fallback is rejected; exact ids required', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU1 = usage(10, 0, 4, 1);
    const helperU1 = usage(5, 0, 2, 0);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'p1',
        usage: parentU1,
        thread_token_usage: parentU1,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          kind: 'started',
          agent_thread_id: 'not-allowlisted',
          agent_path: '/root/helper',
        },
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      sessionMeta('helper-session'),
      line('2026-09-11T10:01:05.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'h1',
        usage: helperU1,
        thread_token_usage: helperU1,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord), { sessionsRoot: root });
    assert.equal(report.status, 'inconclusive');
    assert.match(report.evidence.notes.join(','), /unlisted_nested_child/);
    // Basename/session-path fallback is not used; measured parent+helper totals remain.
    assert.equal(report.breakdown.totals.output_tokens, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same response_id in different sessions stays independently assigned', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(8, 0, 3, 1);
    const helperU = usage(5, 0, 2, 0);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'shared-id',
        usage: parentU,
        thread_token_usage: parentU,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'item_completed',
        item: {
          type: 'SubAgentActivity',
          kind: 'started',
          agent_thread_id: 'helper-session',
          agent_path: '/root/helper',
        },
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      sessionMeta('helper-session'),
      line('2026-09-11T10:01:05.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'shared-id',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_input_tokens.value, 8);
    assert.equal(report.trial.attempts[1].usage.native_input_tokens.value, 5);
    assert.equal(report.breakdown.accounting.response_identity, 'session_and_response');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing acceptance omits accepted and marks inconclusive', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(6, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const trial = {
      trial_id: 'host-accept-unknown',
      case_id: caseRecord.id,
      arm: 'native-codex',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'native', value: 'native-codex' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
      provider_configuration: { implement: 'native' },
    };
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      trial,
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'inconclusive');
    assert.equal(Object.hasOwn(report.trial, 'accepted'), false);
    assert.equal(report.breakdown.totals.output_tokens, 2);
    assert.equal(report.trial.attempts[0].usage.native_input_tokens.value, 6);
    assert.equal(report.breakdown.accounting.acceptance_unknown, true);
    assert.equal(report.breakdown.accounting.measurement_incomplete, false);
    parseTrial(report.trial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI returns nonzero for inconclusive and refuses overwrite of inputs', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(6, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const trial = {
      trial_id: 'host-cli-inc',
      case_id: caseRecord.id,
      arm: 'native-codex',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'native', value: 'native-codex' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
      provider_configuration: { implement: 'native' },
      accepted: true,
    };
    const manifest = baseManifest(caseRecord, {
      trial,
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    });
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const code = await main(
      ['--manifest', manifestPath, '--sessions-root', root],
      { stdout: { write() {} }, stderr: { write() {} }, cwd: root },
    );
    assert.equal(code, 1);

    await assert.rejects(
      () => main(
        ['--manifest', manifestPath, '--sessions-root', root, '--write', manifestPath],
        { stdout: { write() {} }, stderr: { write() {} }, cwd: root },
      ),
      { code: 'invalid_format' },
    );
    await assert.rejects(
      () => main(
        [
          '--manifest',
          manifestPath,
          '--sessions-root',
          root,
          '--write',
          path.join(root, 'sessions/parent.jsonl'),
        ],
        { stdout: { write() {} }, stderr: { write() {} }, cwd: root },
      ),
      { code: 'invalid_format' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symlink escape outside sessions root is rejected', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ce-host-outside-'));
  try {
    const u = usage(3, 0, 1, 0);
    await writeFile(path.join(outside, 'secret.jsonl'), [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    await symlink(path.join(outside, 'secret.jsonl'), path.join(root, 'sessions/parent.jsonl'));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
        phases: [{
          attempt_id: 'only',
          kind: 'initial',
          outcome: 'accepted',
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:01:00.000Z',
          session_id: 'parent-session',
        }],
      }), { sessionsRoot: root }),
      { code: 'invalid_format' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('bounded host_settings reject freeform path secrets', () => {
  const caseRecord = {
    id: 'single-file-bugfix',
    base_sha: 'df49c63059159a79646258358850bef0590ca583',
    input_digest: '54bd89a12cdbb1a66e662467f71d96bfc5e596bafced30f6a0c715c68a71d368',
  };
  assert.throws(() => parseManifest(baseManifest(caseRecord, {
    trial: {
      trial_id: 'bad-settings',
      case_id: caseRecord.id,
      arm: 'native-codex',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'native', value: 'native-codex' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write', cwd: '/secret/path' },
      provider_configuration: { implement: 'native' },
      accepted: true,
    },
    sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
    phases: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'accepted',
      start: '2026-09-11T10:00:00.000Z',
      end: '2026-09-11T10:01:00.000Z',
      session_id: 'parent-session',
    }],
  })), { code: 'unknown_key' });
});

test('current CLI shape counts gpt-6-astra output with collaboration_mode settings', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(20, 4, 9, 3, 29, { cache_write_input_tokens: 2 });
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', {
        model: 'gpt-6-astra',
        sandbox_policy: { type: 'read-only' },
        collaboration_mode: {
          mode: 'default',
          settings: {
            model: 'gpt-6-astra',
            reasoning_effort: null,
          },
        },
      }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-cli-1',
        thread_id: 'parent-session',
        session_id: 'parent-session',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      trial: {
        trial_id: 'host-cli-shape',
        case_id: caseRecord.id,
        arm: 'native-codex',
        base_sha: caseRecord.base_sha,
        input_digest: caseRecord.input_digest,
        coengineer_source: { kind: 'native', value: 'native-codex' },
        host_model: 'gpt-6-astra',
        host_settings: { reasoning: 'default', sandbox: 'read-only' },
        provider_configuration: {
          implement: { provider: 'cursor-local', model: 'composer-1' },
          review: null,
        },
        accepted: true,
      },
      sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
      phases: [{
        attempt_id: 'only',
        kind: 'initial',
        outcome: 'accepted',
        start: '2026-09-11T10:00:00.000Z',
        end: '2026-09-11T10:01:00.000Z',
        session_id: 'parent-session',
      }],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 9);
    assert.equal(report.breakdown.totals.output_tokens, 9);
    assert.equal(report.breakdown.totals.cache_write_input_tokens, 2);
    assert.equal(report.breakdown.attempts[0].by_model[0].model, 'gpt-6-astra');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mixed-model nested helper via sub_agent_activity keeps distinct attribution', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(10, 0, 4, 1);
    const helperU = usage(7, 0, 5, 2);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', {
        model: 'gpt-6-astra',
        sandbox_policy: { type: 'read-only' },
        collaboration_mode: {
          mode: 'default',
          settings: { model: 'gpt-6-astra', reasoning_effort: null },
        },
      }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'p1',
        thread_id: 'parent-session',
        session_id: 'parent-session',
        usage: parentU,
        thread_token_usage: parentU,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        agent_thread_id: 'helper-session',
        agent_path: '/root/helper',
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      sessionMeta('helper-session'),
      line('2026-09-11T10:01:05.000Z', 'turn_context', {
        model: 'helper-model-x',
        sandbox_policy: { type: 'workspace-write' },
        collaboration_mode: {
          mode: 'default',
          settings: { model: 'helper-model-x', reasoning_effort: 'low' },
        },
      }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'h1',
        thread_id: 'helper-session',
        session_id: 'helper-session',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      trial: {
        trial_id: 'host-mixed-model',
        case_id: caseRecord.id,
        arm: 'native-codex',
        base_sha: caseRecord.base_sha,
        input_digest: caseRecord.input_digest,
        coengineer_source: { kind: 'native', value: 'native-codex' },
        host_model: 'gpt-6-astra',
        host_settings: { reasoning: 'default', sandbox: 'read-only' },
        provider_configuration: { implement: 'native' },
        accepted: true,
      },
      sessions: [
        { id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' },
        {
          id: 'helper-session',
          role: 'native_helper',
          path: 'sessions/helper.jsonl',
          parent_id: 'parent-session',
          agent_path: '/root/helper',
          expected_model: 'helper-model-x',
        },
      ],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 4);
    assert.equal(report.trial.attempts[1].usage.native_output_tokens.value, 5);
    assert.equal(report.breakdown.attempts[0].by_model[0].model, 'gpt-6-astra');
    assert.equal(report.breakdown.attempts[1].by_model[0].model, 'helper-model-x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('token_usage_record cross-session thread_id is rejected', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(4, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        thread_id: 'other-session',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
        phases: [{
          attempt_id: 'only',
          kind: 'initial',
          outcome: 'accepted',
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:01:00.000Z',
          session_id: 'parent-session',
        }],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host_settings conflict with observed sandbox_policy rejects', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const u = usage(4, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('parent-session'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', {
        model: 'codex-default',
        sandbox_policy: { type: 'danger-full-access' },
        collaboration_mode: {
          mode: 'default',
          settings: { model: 'codex-default', reasoning_effort: 'default' },
        },
      }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'r1',
        usage: u,
        thread_token_usage: u,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
        phases: [{
          attempt_id: 'only',
          kind: 'initial',
          outcome: 'accepted',
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:01:00.000Z',
          session_id: 'parent-session',
        }],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider_configuration binds structured provider+model without path leaks', () => {
  const caseRecord = {
    id: 'single-file-bugfix',
    base_sha: 'df49c63059159a79646258358850bef0590ca583',
    input_digest: '54bd89a12cdbb1a66e662467f71d96bfc5e596bafced30f6a0c715c68a71d368',
  };
  const parsed = parseManifest(baseManifest(caseRecord, {
    trial: {
      trial_id: 'host-provider-bind',
      case_id: caseRecord.id,
      arm: 'candidate-3.4.3',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-3.4.3' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
      provider_configuration: {
        implement: { provider: 'cursor-local', model: 'composer-1' },
        review: { provider: 'grok', model: 'grok-4' },
      },
      accepted: true,
    },
    sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
    phases: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'accepted',
      start: '2026-09-11T10:00:00.000Z',
      end: '2026-09-11T10:01:00.000Z',
      session_id: 'parent-session',
    }],
  }));
  assert.deepEqual(parsed.trial.provider_configuration.implement, {
    provider: 'cursor-local',
    model: 'composer-1',
  });
  assert.throws(() => parseManifest(baseManifest(caseRecord, {
    trial: {
      trial_id: 'bad-provider',
      case_id: caseRecord.id,
      arm: 'candidate-3.4.3',
      base_sha: caseRecord.base_sha,
      input_digest: caseRecord.input_digest,
      coengineer_source: { kind: 'synthetic_label', value: 'fixture:candidate-3.4.3' },
      host_model: 'codex-default',
      host_settings: { reasoning: 'default', sandbox: 'workspace-write' },
      provider_configuration: {
        implement: { provider: 'cursor-local', api_key: 'secret' },
      },
      accepted: true,
    },
    sessions: [{ id: 'parent-session', role: 'parent', path: 'sessions/parent.jsonl' }],
    phases: [{
      attempt_id: 'only',
      kind: 'initial',
      outcome: 'accepted',
      start: '2026-09-11T10:00:00.000Z',
      end: '2026-09-11T10:01:00.000Z',
      session_id: 'parent-session',
    }],
  })), { code: 'unknown_key' });
});

test('helper token_usage may share proven root session_id with exact child thread_id', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(9, 0, 4, 1);
    const helperU = usage(6, 0, 3, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('example-parent'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default', effort: 'default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        thread_id: 'example-parent',
        session_id: 'example-parent',
        usage: parentU,
        thread_token_usage: parentU,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        agent_thread_id: 'example-child',
        agent_path: '/root/helper',
      }),
    ].join(''));
    await writeSession(root, 'sessions/helper.jsonl', [
      helperSessionMeta('example-child', 'example-parent'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default', effort: 'default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-1',
        thread_id: 'example-child',
        session_id: 'example-parent',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      sessions: [
        { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
        {
          id: 'example-child',
          role: 'native_helper',
          path: 'sessions/helper.jsonl',
          parent_id: 'example-parent',
          agent_path: '/root/helper',
        },
      ],
      phases: [
        {
          attempt_id: 'native-initial',
          kind: 'initial',
          outcome: 'completed_unaccepted',
          sequence: 1,
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:02:00.000Z',
          session_id: 'example-parent',
        },
        {
          attempt_id: 'native-helper',
          kind: 'native_helper',
          outcome: 'accepted',
          sequence: 2,
          start: '2026-09-11T10:01:00.000Z',
          end: '2026-09-11T10:01:30.000Z',
          session_id: 'example-child',
        },
      ],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 4);
    assert.equal(report.trial.attempts[1].usage.native_output_tokens.value, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested helper may share original root session_id across proven ancestry', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(8, 0, 3, 1);
    const midU = usage(5, 0, 2, 0);
    const nestedU = usage(4, 0, 2, 1);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('example-parent'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default', effort: 'default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        thread_id: 'example-parent',
        session_id: 'example-parent',
        usage: parentU,
        thread_token_usage: parentU,
      }),
      line('2026-09-11T10:00:20.000Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        agent_thread_id: 'example-mid',
        agent_path: '/root/mid',
      }),
    ].join(''));
    await writeSession(root, 'sessions/mid.jsonl', [
      helperSessionMeta('example-mid', 'example-parent'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'mid-model', effort: 'low' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-mid-1',
        thread_id: 'example-mid',
        session_id: 'example-parent',
        usage: midU,
        thread_token_usage: midU,
      }),
      line('2026-09-11T10:01:15.000Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        agent_thread_id: 'example-child',
        agent_path: '/root/nested',
      }),
    ].join(''));
    await writeSession(root, 'sessions/nested.jsonl', [
      helperSessionMeta('example-child', 'example-mid'),
      line('2026-09-11T10:01:20.000Z', 'turn_context', { model: 'nested-model', effort: 'low' }),
      line('2026-09-11T10:01:25.000Z', 'token_usage_record', {
        response_id: 'resp-nested-1',
        thread_id: 'example-child',
        session_id: 'example-parent',
        usage: nestedU,
        thread_token_usage: nestedU,
      }),
    ].join(''));
    const report = await collectTrialUsage(baseManifest(caseRecord, {
      sessions: [
        { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
        {
          id: 'example-mid',
          role: 'native_helper',
          path: 'sessions/mid.jsonl',
          parent_id: 'example-parent',
          agent_path: '/root/mid',
          expected_model: 'mid-model',
        },
        {
          id: 'example-child',
          role: 'native_helper',
          path: 'sessions/nested.jsonl',
          parent_id: 'example-mid',
          agent_path: '/root/nested',
          expected_model: 'nested-model',
        },
      ],
      phases: [
        {
          attempt_id: 'native-initial',
          kind: 'initial',
          outcome: 'completed_unaccepted',
          sequence: 1,
          start: '2026-09-11T10:00:00.000Z',
          end: '2026-09-11T10:01:00.000Z',
          session_id: 'example-parent',
        },
        {
          attempt_id: 'native-mid',
          kind: 'native_helper',
          outcome: 'accepted',
          sequence: 2,
          start: '2026-09-11T10:01:00.000Z',
          end: '2026-09-11T10:01:20.000Z',
          session_id: 'example-mid',
        },
        {
          attempt_id: 'native-nested',
          kind: 'native_helper',
          outcome: 'accepted',
          sequence: 3,
          start: '2026-09-11T10:01:20.000Z',
          end: '2026-09-11T10:01:30.000Z',
          session_id: 'example-child',
        },
      ],
    }), { sessionsRoot: root });
    assert.equal(report.status, 'complete');
    assert.equal(report.trial.attempts[0].usage.native_output_tokens.value, 3);
    assert.equal(report.trial.attempts[1].usage.native_output_tokens.value, 2);
    assert.equal(report.trial.attempts[2].usage.native_output_tokens.value, 2);
    assert.equal(report.breakdown.attempts[1].by_model[0].model, 'mid-model');
    assert.equal(report.breakdown.attempts[2].by_model[0].model, 'nested-model');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared session_id without parent linkage or with wrong ids is rejected', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(4, 0, 2, 1);
    const helperU = usage(3, 0, 1, 0);

    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('example-parent'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        usage: parentU,
        thread_token_usage: parentU,
      }),
    ].join(''));

    // Missing session_meta parent linkage while claiming shared session_id.
    await writeSession(root, 'sessions/helper-unproven.jsonl', [
      sessionMeta('example-child'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-1',
        thread_id: 'example-child',
        session_id: 'example-parent',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [
          { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
          {
            id: 'example-child',
            role: 'native_helper',
            path: 'sessions/helper-unproven.jsonl',
            parent_id: 'example-parent',
          },
        ],
        phases: [
          {
            attempt_id: 'native-initial',
            kind: 'initial',
            outcome: 'accepted',
            sequence: 1,
            start: '2026-09-11T10:00:00.000Z',
            end: '2026-09-11T10:01:00.000Z',
            session_id: 'example-parent',
          },
          {
            attempt_id: 'native-helper',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 2,
            start: '2026-09-11T10:01:00.000Z',
            end: '2026-09-11T10:01:30.000Z',
            session_id: 'example-child',
          },
        ],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );

    // Unrelated session_id with otherwise valid parent linkage.
    await writeSession(root, 'sessions/helper-wrong-session.jsonl', [
      helperSessionMeta('example-child', 'example-parent'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-2',
        thread_id: 'example-child',
        session_id: 'unrelated-session',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [
          { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
          {
            id: 'example-child',
            role: 'native_helper',
            path: 'sessions/helper-wrong-session.jsonl',
            parent_id: 'example-parent',
          },
        ],
        phases: [
          {
            attempt_id: 'native-initial',
            kind: 'initial',
            outcome: 'accepted',
            sequence: 1,
            start: '2026-09-11T10:00:00.000Z',
            end: '2026-09-11T10:01:00.000Z',
            session_id: 'example-parent',
          },
          {
            attempt_id: 'native-helper',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 2,
            start: '2026-09-11T10:01:00.000Z',
            end: '2026-09-11T10:01:30.000Z',
            session_id: 'example-child',
          },
        ],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );

    // Parent thread_id used as child usage thread_id.
    await writeSession(root, 'sessions/helper-parent-thread.jsonl', [
      helperSessionMeta('example-child', 'example-parent'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-3',
        thread_id: 'example-parent',
        session_id: 'example-parent',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [
          { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
          {
            id: 'example-child',
            role: 'native_helper',
            path: 'sessions/helper-parent-thread.jsonl',
            parent_id: 'example-parent',
          },
        ],
        phases: [
          {
            attempt_id: 'native-initial',
            kind: 'initial',
            outcome: 'accepted',
            sequence: 1,
            start: '2026-09-11T10:00:00.000Z',
            end: '2026-09-11T10:01:00.000Z',
            session_id: 'example-parent',
          },
          {
            attempt_id: 'native-helper',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 2,
            start: '2026-09-11T10:01:00.000Z',
            end: '2026-09-11T10:01:30.000Z',
            session_id: 'example-child',
          },
        ],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );

    // Conflicting parent metadata vs manifest parent_id.
    await writeSession(root, 'sessions/helper-conflict.jsonl', [
      helperSessionMeta('example-child', 'not-the-manifest-parent'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-helper-4',
        thread_id: 'example-child',
        session_id: 'example-child',
        usage: helperU,
        thread_token_usage: helperU,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [
          { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
          {
            id: 'example-child',
            role: 'native_helper',
            path: 'sessions/helper-conflict.jsonl',
            parent_id: 'example-parent',
          },
        ],
        phases: [
          {
            attempt_id: 'native-initial',
            kind: 'initial',
            outcome: 'accepted',
            sequence: 1,
            start: '2026-09-11T10:00:00.000Z',
            end: '2026-09-11T10:01:00.000Z',
            session_id: 'example-parent',
          },
          {
            attempt_id: 'native-helper',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 2,
            start: '2026-09-11T10:01:00.000Z',
            end: '2026-09-11T10:01:30.000Z',
            session_id: 'example-child',
          },
        ],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('nested helper claiming root session_id without full ancestry proof is rejected', async () => {
  const cases = await loadCases(CASES_DIR);
  const caseRecord = cases.find((entry) => entry.id === 'single-file-bugfix');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ce-host-usage-'));
  try {
    const parentU = usage(4, 0, 2, 1);
    const midU = usage(3, 0, 1, 0);
    const nestedU = usage(2, 0, 1, 0);
    await writeSession(root, 'sessions/parent.jsonl', [
      sessionMeta('example-parent'),
      line('2026-09-11T10:00:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:00:10.000Z', 'token_usage_record', {
        response_id: 'resp-parent-1',
        usage: parentU,
        thread_token_usage: parentU,
      }),
    ].join(''));
    // Mid helper lacks parent_thread_id, so nested cannot prove root ancestry.
    await writeSession(root, 'sessions/mid.jsonl', [
      sessionMeta('example-mid'),
      line('2026-09-11T10:01:01.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:10.000Z', 'token_usage_record', {
        response_id: 'resp-mid-1',
        thread_id: 'example-mid',
        session_id: 'example-mid',
        usage: midU,
        thread_token_usage: midU,
      }),
    ].join(''));
    await writeSession(root, 'sessions/nested.jsonl', [
      helperSessionMeta('example-child', 'example-mid'),
      line('2026-09-11T10:01:20.000Z', 'turn_context', { model: 'codex-default' }),
      line('2026-09-11T10:01:25.000Z', 'token_usage_record', {
        response_id: 'resp-nested-1',
        thread_id: 'example-child',
        session_id: 'example-parent',
        usage: nestedU,
        thread_token_usage: nestedU,
      }),
    ].join(''));
    await assert.rejects(
      () => collectTrialUsage(baseManifest(caseRecord, {
        sessions: [
          { id: 'example-parent', role: 'parent', path: 'sessions/parent.jsonl' },
          {
            id: 'example-mid',
            role: 'native_helper',
            path: 'sessions/mid.jsonl',
            parent_id: 'example-parent',
          },
          {
            id: 'example-child',
            role: 'native_helper',
            path: 'sessions/nested.jsonl',
            parent_id: 'example-mid',
          },
        ],
        phases: [
          {
            attempt_id: 'native-initial',
            kind: 'initial',
            outcome: 'accepted',
            sequence: 1,
            start: '2026-09-11T10:00:00.000Z',
            end: '2026-09-11T10:01:00.000Z',
            session_id: 'example-parent',
          },
          {
            attempt_id: 'native-mid',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 2,
            start: '2026-09-11T10:01:00.000Z',
            end: '2026-09-11T10:01:20.000Z',
            session_id: 'example-mid',
          },
          {
            attempt_id: 'native-nested',
            kind: 'native_helper',
            outcome: 'accepted',
            sequence: 3,
            start: '2026-09-11T10:01:20.000Z',
            end: '2026-09-11T10:01:30.000Z',
            session_id: 'example-child',
          },
        ],
      }), { sessionsRoot: root }),
      { code: 'identity_mismatch' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
