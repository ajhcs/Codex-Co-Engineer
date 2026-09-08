import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  boundedEvent,
  createGrokFinalResponseReducerV1,
  handlePermissionRequest,
  isUserFacingPermission,
  publicError,
  reconnectAcpTask,
  runAcpTask,
  runCliFallback,
  safeQuestionId,
  sanitizeText,
  workerSeamIncident,
} from '../mcp/v3/acp-worker.mjs';
import { installClosedProviderTestInjection } from '../mcp/v3/credential-boundary.mjs';
import { submitReply } from '../mcp/v3/mailbox.mjs';
import { createTask, readTask, updateTask } from '../mcp/v3/task-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'acpx-fake-agent.mjs');
const FAKE_ACPX = path.join(HERE, 'fake-acpx.mjs');
const FAKE_CLI_TERMINAL_VERDICT = path.join(HERE, 'fake-cli-terminal-verdict.mjs');

async function fixture(extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-acp-'));
  const cwd = path.join(root, 'worktree');
  await mkdir(cwd);
  await createTask({
    root,
    prompt: extra.prompt ?? 'review this repository',
    record: {
      id: extra.id ?? 'task-1',
      status: 'accepted',
      provider: extra.provider ?? 'grok',
      ...(extra.dshModel ? { dsh_model: extra.dshModel } : {}),
      cwd,
      agent_argv: extra.agentArgv ?? [process.execPath, FAKE_AGENT, '--mode', extra.mode ?? 'normal'],
      ...(extra.cliArgv ? { cli_argv: extra.cliArgv } : {}),
      timeout_ms: extra.timeoutMs ?? 5_000,
    },
  });
  return { root, cwd, taskId: extra.id ?? 'task-1' };
}

async function withFakeAcpx(mode, callback, options = {}) {
  const names = ['CODEX_CO_ENGINEER_ACPX_COMMAND'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = FAKE_ACPX;
  const injection = { FAKE_ACPX_MODE: mode };
  if (options.artifactMarker) injection.FAKE_ACPX_ARTIFACT_MARKER = options.artifactMarker;
  if (options.descendantPidFile) injection.FAKE_ACPX_DESCENDANT_PID_FILE = options.descendantPidFile;
  installClosedProviderTestInjection(injection);
  try {
    return await callback();
  } finally {
    installClosedProviderTestInjection(null);
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('typed ACP tool permissions do not become user questions from command text', () => {
  for (const title of [
    'Run `echo "exit=$?"`',
    'Execute confirm-release-state --dry-run',
    'Approval required by the shell script',
  ]) {
    assert.equal(isUserFacingPermission({
      inferredKind: 'execute',
      raw: { toolCall: { kind: 'execute', title } },
    }), false);
  }
  assert.equal(isUserFacingPermission({
    inferredKind: 'other',
    raw: { question: 'Which release channel should I use?', toolCall: { title: 'Ask operator' } },
  }), true);
  assert.equal(isUserFacingPermission({
    inferredKind: 'other',
    raw: { toolCall: { title: 'Fake permission' } },
  }), true);
  assert.equal(isUserFacingPermission({
    inferredKind: 'other',
    raw: { toolCall: { title: 'Confirm release to production?' } },
  }), true);
  assert.equal(isUserFacingPermission({
    inferredKind: 'other',
    raw: { toolCall: { title: 'Which environment should I use?' } },
  }), true);
  assert.equal(isUserFacingPermission({
    inferredKind: 'other',
    raw: { toolCall: { title: 'Run `echo "exit=$?"`' } },
  }), false);
});

test('long ACP permission ids retain a bounded collision-resistant identity', () => {
  const shared = `call-${'a'.repeat(100)}`;
  const first = safeQuestionId(`${shared}-one`);
  const second = safeQuestionId(`${shared}-two`);
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
  assert.equal(first.length, 80);
  assert.notEqual(first, second);
  assert.equal(safeQuestionId('fake-permission'), 'fake-permission');
});

async function processExited(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('runs a prompt through ACP and persists a compact receipt', async () => {
  const value = await fixture();
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.transport, 'acp');
  assert.equal(terminal.prompt_dispatched, true);
  assert.match(terminal.acp_session_id, /^fake-session-/u);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /session_ready/u);
  assert.match(events, /fake-chunk-1/u);
  assert.match(events, /"status":"completed"/u);
  assert.equal(terminal.cleanup.status, 'pending');
  assert.equal(terminal.cleanup.acp_close, 'closed');
  assert.equal(workerSeamIncident(terminal), false);
  assert.match(events, /"type":"cleanup"/u);
});

test('Grok selects the final framed response while retaining pre-tool text in provider events', async () => {
  for (const provider of ['grok', 'cursor-local']) {
    const value = await fixture({
      provider,
      id: `${provider}-framed-final`,
      prompt: 'review the framed result',
      mode: 'framed-final',
    });
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(
      terminal.result,
      provider === 'grok' ? 'fake-final-answer' : 'fake-opening-preamblefake-final-answer',
    );
    const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
    assert.match(events, /fake-opening-preamble/u);
    assert.match(events, /fake-final-answer/u);
  }
});

test('Grok final framing falls back when reduction could hide output', () => {
  const text = (value) => ({ type: 'text_delta', stream: 'output', text: value });
  const call = (id, rawInput = { variant: 'ReadFile' }) => ({
    type: 'tool_call', tag: 'tool_call', toolCallId: id, rawInput,
  });
  const done = (id) => ({
    type: 'tool_call', tag: 'tool_call_update', toolCallId: id, status: 'completed',
  });
  const completed = { status: 'completed', stopReason: 'end_turn' };
  const finish = (events, options = {}) => {
    const reducer = createGrokFinalResponseReducerV1();
    for (const event of events) reducer.append(event);
    return reducer.finish({
      turnResult: options.turnResult ?? completed,
      fullSnapshot: { overflow: options.overflow === true },
    });
  };

  const selected = finish([text('preamble'), call('read'), done('read'), text('final')]);
  assert.equal(selected.bounded.value, 'final');
  assert.equal(selected.snapshot.source.toString('utf8'), 'final');

  const parallel = finish([
    text('preamble'), call('one'), call('two'), done('one'), done('two'), text('parallel-final'),
  ]);
  assert.equal(parallel.bounded.value, 'parallel-final');
  const sequential = finish([
    text('preamble'), call('one'), done('one'), text('between'), call('two'), done('two'),
    text('final-'), text('chunks'),
  ]);
  assert.equal(sequential.bounded.value, 'final-chunks');

  const fallbacks = [
    ['whitespace final', [text('preamble'), call('read'), done('read'), text('   ')], {}],
    ['full collector overflow', [text('preamble'), call('read'), done('read'), text('final')], { overflow: true }],
    ['text while tool pending', [text('preamble'), call('read'), text('interleaved'), done('read'), text('final')], {}],
    ['text after partial settle', [text('preamble'), call('one'), call('two'), done('one'), text('interleaved'), done('two'), text('final')], {}],
    ['web search', [text('preamble'), call('search', { variant: 'WebSearch' }), done('search'), text('final')], {}],
    ['unmatched terminal', [text('preamble'), done('missing'), text('final')], {}],
    ['duplicate pending id', [text('preamble'), call('same'), call('same'), done('same'), text('final')], {}],
    ['missing id', [text('preamble'), call(null), text('final')], {}],
    ['overlong id', [text('preamble'), call('x'.repeat(513)), text('final')], {}],
    ['pending tool', [text('partial'), call('pending')], {}],
    ['pending after settled round', [text('preamble'), call('one'), done('one'), text('candidate'), call('pending')], {}],
    ['failed turn', [text('preamble'), call('read'), done('read'), text('failure detail')], { turnResult: { status: 'failed', stopReason: 'error' } }],
    ['non-end turn', [text('preamble'), call('read'), done('read'), text('partial')], { turnResult: { status: 'completed', stopReason: 'max_tokens' } }],
  ];
  for (const [name, events, options] of fallbacks) {
    assert.equal(finish(events, options), null, name);
  }
});

for (const provider of ['grok', 'cursor-local']) {
  test(`${provider} preserves a terminal verdict at the end of long ACP output`, async () => {
    const value = await fixture({
      provider,
      id: `${provider}-terminal-verdict`,
      prompt: 'terminal-verdict',
    });
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(terminal.status, 'completed');
    assert.match(terminal.result, /VERDICT: ACP PASS$/u);
    assert.equal(terminal.result_truncated, true);
    assert.equal(terminal.result_original_chars, 5_018);
    const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
    assert.match(events, /"type":"provider"/u);
  });
}

test('does not start a fresh ACP worker from transport_lost', async () => {
  const value = await fixture({ id: 'transport-lost-start' });
  await updateTask(value.root, value.taskId, { status: 'transport_lost' });
  await assert.rejects(
    runAcpTask({ root: value.root, taskId: value.taskId }),
    (error) => error.code === 'transport_lost',
  );
});

test('reconnects an acknowledged ACP session without replaying its prompt', async () => {
  const value = await fixture({ id: 'same-session-reconnect' });
  await updateTask(value.root, value.taskId, {
    status: 'transport_lost',
    transport: 'acp',
    prompt_dispatched: true,
    dispatch_evidence: 'authoritative',
    acp_session_id: 'persisted-acp-session',
  });
  let ensureInput;
  let startTurnCalled = false;
  let closed = false;
  const resumed = await reconnectAcpTask({
    root: value.root,
    taskId: value.taskId,
    runtimeFactory: async () => ({
      ensureSession: async (input) => {
        ensureInput = input;
        return {
          backendSessionId: 'persisted-acp-session',
          agentSessionId: 'persisted-agent-session',
        };
      },
      getStatus: async () => ({ status: 'running' }),
      startTurn: async () => {
        startTurnCalled = true;
        throw new Error('resume path must not start a turn');
      },
      close: async () => {
        closed = true;
      },
    }),
  });

  assert.equal(resumed.reconnected, true);
  assert.equal(resumed.prompt_replayed, false);
  assert.equal(ensureInput.resumeSessionId, 'persisted-acp-session');
  assert.equal(startTurnCalled, false);
  assert.equal(closed, true);
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'running');
  assert.equal(task.prompt_dispatched, true);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /session_reconnected/u);
  assert.match(events, /prompt_replayed":false/u);
});

test('recursively bounds and redacts provider events and errors', () => {
  const prompt = 'private prompt sk-prompt-secret-1234567890';
  const event = {
    type: 'provider_update',
    text: `${prompt} xai-live-secret-1234567890`,
    nested: {
      prompt,
      apiKey: 'sk-live-secret-1234567890',
      authorization: 'Bearer live-secret-1234567890',
      token: 'structured-token-secret-1234567890',
      bearer: 'structured-bearer-secret-1234567890',
      rawOutput: 'private provider payload',
      deep: { deeper: { deepest: { value: 'bounded' } } },
    },
    list: Array.from({ length: 80 }, (_, index) => `entry-${index}`),
    huge: 'x'.repeat(20_000),
  };
  const safe = boundedEvent(event, prompt);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /private prompt|sk-prompt-secret|xai-live-secret|sk-live-secret|Bearer live-secret|structured-token-secret|structured-bearer-secret/u);
  assert.equal(safe.nested.apiKey, '[REDACTED]');
  assert.equal(safe.nested.authorization, '[REDACTED]');
  assert.equal(safe.nested.token, '[REDACTED]');
  assert.equal(safe.nested.bearer, '[REDACTED]');
  assert.equal(safe.nested.rawOutput, undefined);
  assert.ok(serialized.length < 32 * 1024);
  assert.equal(sanitizeText(`failure: ${prompt} ghp_live-secret-1234567890`, prompt).includes(prompt), false);
  const failure = publicError(new Error(`provider failed for ${prompt} with token ghp_live-secret-1234567890`), prompt);
  assert.doesNotMatch(failure.message, /private prompt|ghp_live-secret/u);
});

test('redacts environment-style assignments and bearer tokens from ACP events and errors', () => {
  const prompt = 'private assignment prompt';
  const assignments = [
    ['MODEL_API_KEY', 'plain-model-value-1234567890'].join('='),
    ['OPENROUTER_API_KEY', 'plain-openrouter-value-1234567890'].join('='),
    ['CURSOR_API_KEY', 'plain-cursor-value-1234567890'].join(': '),
    ['XAI_API_KEY', 'plain-xai-value-1234567890'].join(' = '),
    ['Authorization', ['Bearer', 'short-bearer-value-1234567890'].join(' ')].join(': '),
  ].join('\n');
  const payload = `${prompt}\n${assignments}`;
  const event = boundedEvent({ type: 'provider_update', text: payload, nested: { detail: payload } }, prompt);
  const failure = publicError(new Error(payload), prompt);
  for (const output of [JSON.stringify(event), failure.message]) {
    assert.doesNotMatch(output, /private assignment prompt|plain-model-value|plain-openrouter-value|plain-cursor-value|plain-xai-value|short-bearer-value/iu);
  }
});

test('ACP startup failure falls back once before prompt dispatch', async () => {
  const value = await fixture({
    agentArgv: ['/definitely/missing/acp-agent'],
    cliArgv: [process.execPath, '-e', 'process.stdout.write("CLI_FALLBACK_OK")'],
    id: 'startup-failure',
  });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(terminal.status, 'completed');
  assert.equal(task.transport, 'cli');
  assert.equal(task.fallback_from, 'acp');
  assert.equal(task.result, 'CLI_FALLBACK_OK');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.fallback_safe, false);
});

test('CLI fallback preserves a terminal verdict at the end of long output', async () => {
  const value = await fixture({
    id: 'cli-terminal-verdict',
    cliArgv: [process.execPath, FAKE_CLI_TERMINAL_VERDICT],
  });
  const terminal = await runCliFallback({
    root: value.root,
    task: (await readTask(value.root, value.taskId)).task,
    prompt: 'private fallback prompt',
  });
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result, /VERDICT: CLI PASS$/u);
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.result_original_chars, 5_018);
});

test('pre-aborted CLI fallback records a terminal cancellation', async () => {
  const value = await fixture({
    id: 'pre-aborted-fallback',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runCliFallback({ root: value.root, task: (await readTask(value.root, value.taskId)).task, prompt: 'private fallback prompt', signal: controller.signal }),
    (error) => error.code === 'cancelled',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.error.code, 'cancelled');
  assert.ok(task.finished_at);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /"status":"cancelled"/u);
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).some((entry) => entry.startsWith('cli-prompt-')), false);
});

test('authentication failures do not trigger a futile CLI fallback', async () => {
  const value = await fixture({
    agentArgv: [process.execPath, '-e', 'console.error("Not signed in"); process.exit(1)'],
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
    id: 'auth-failure',
  });
  await assert.rejects(runAcpTask({ root: value.root, taskId: value.taskId }));
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.transport, 'acp');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_safe, true);
});

test('provider failure after dispatch is never marked safe to replay', async () => {
  const value = await fixture({ prompt: 'provider-failure', id: 'provider-failure' });
  const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
  assert.equal(terminal.status, 'failed');
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.fallback_safe, false);
  assert.equal(task.cleanup.status, 'pending');
  assert.equal(workerSeamIncident(task), false);
});

test('DSH uses bounded ACPX exec stdin and scopes artifacts to the task', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-flow' });
  await updateTask(value.root, value.taskId, {
    error: { code: 'worker_boundary_uncertain', message: 'stale reconciliation marker' },
  });
  const artifactMarker = path.join(value.root, 'artifact-created');
  await withFakeAcpx('success', async () => {
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.transport, 'acp');
    assert.equal(terminal.result, 'DSH_FAKE_OK');
    assert.equal(terminal.error, null);
    assert.equal(terminal.acp_session_id, 'dsh-fake-session');
    assert.equal(terminal.dispatch_uncertain, false);
    assert.equal(terminal.prompt_dispatched, true);
    assert.equal(terminal.dispatch_evidence, 'authoritative');
    const observed = JSON.parse(await readFile(path.join(value.cwd, '.acpx-fake-observed.json'), 'utf8'));
    assert.ok(observed.argv.includes('exec'));
    assert.ok(observed.argv.includes('--file'));
    assert.ok(observed.argv.includes('-'));
    assert.equal(observed.argv.includes('review this repository'), false);
    await access(artifactMarker);
    const entries = await readdir(path.join(value.root, 'tasks', value.taskId));
    assert.equal(entries.some((entry) => entry.startsWith('flow-input-')), false);
    assert.equal(entries.includes('acpx-home'), false);
  }, { artifactMarker });
});

test('DSH ACPX preserves a terminal verdict at the end of long output', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-terminal-verdict' });
  const terminal = await withFakeAcpx('terminal-verdict', () => runAcpTask({ root: value.root, taskId: value.taskId }));
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result, /VERDICT: DSH PASS$/u);
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.result_original_chars, 5_018);
});

test('DSH ACPX preserves bounded nested output values', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-terminal-object' });
  const terminal = await withFakeAcpx('terminal-object', () => runAcpTask({ root: value.root, taskId: value.taskId }));
  assert.equal(terminal.status, 'completed');
  assert.match(terminal.result.nested.final, /VERDICT: DSH OBJECT PASS$/u);
  assert.equal(terminal.result_truncated, true);
  assert.equal(terminal.result_original_chars, 10_025);
});

test('DSH exposes a correlated provider billing failure without replay or prompt leakage', async () => {
  const cliMarker = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-billing-'))), 'cli-ran');
  const prompt = 'private billing prompt';
  const value = await fixture({
    provider: 'dsh',
    id: 'dsh-provider-billing',
    prompt,
    cliArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'ran')`],
  });
  await assert.rejects(
    withFakeAcpx('provider-error', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'provider_billing_required',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'provider_billing_required');
  assert.equal(task.error.message, 'The provider billing configuration is unavailable.');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.dispatch_evidence, 'authoritative');
  assert.equal(task.dispatch_uncertain, false);
  assert.equal(task.fallback_safe, false);
  await assert.rejects(access(cliMarker));
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, new RegExp(prompt, 'u'));
});

test('DSH keeps an ACP authentication rejection pre-dispatch and does not fall back', async () => {
  const cliMarker = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-auth-'))), 'cli-ran');
  const value = await fixture({
    provider: 'dsh',
    id: 'dsh-provider-auth',
    cliArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'ran')`],
  });
  await assert.rejects(
    withFakeAcpx('auth-error', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'authentication_required',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.error.code, 'authentication_required');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_safe, false);
  await assert.rejects(access(cliMarker));
});

test('DSH rejects an uncorrelated or incomplete ACP prompt result', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-invalid-result' });
  await assert.rejects(
    withFakeAcpx('invalid-result', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_invalid_result',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.fallback_safe, false);
});

test('DSH rejects an unmatched terminal response instead of manufacturing success', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-unmatched-result' });
  await assert.rejects(
    withFakeAcpx('unmatched-result', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_invalid_result',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.result, undefined);
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.fallback_safe, false);
});

test('DSH treats thought updates as dispatch evidence without persisting thought text', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-thought-first' });
  const terminal = await withFakeAcpx('thought-first', () => runAcpTask({ root: value.root, taskId: value.taskId }));
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.result, 'THOUGHT_RESULT');
  assert.equal(terminal.dispatch_evidence, 'authoritative');
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /PRIVATE_THOUGHT_SHOULD_NOT_BE_STORED/u);
});

test('DSH preserves split UTF-8 ACPX output while parsing correlated frames', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-utf8-output' });
  const terminal = await withFakeAcpx('utf8', () => runAcpTask({ root: value.root, taskId: value.taskId }));
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.result, 'UTF8_OK 😀 café');
});

test('DSH fails closed on malformed ACPX JSON output', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-malformed-output' });
  await assert.rejects(
    withFakeAcpx('malformed', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_protocol_invalid',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.result, undefined);
  assert.equal(task.fallback_safe, false);
});

test('DSH rejects a prompt request whose session differs from session/new', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-wrong-prompt-session' });
  await assert.rejects(
    withFakeAcpx('wrong-session', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_protocol_invalid',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.dispatch_uncertain, true);
});

test('DSH rejects duplicate outstanding ACPX request ids', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-duplicate-request-id' });
  await assert.rejects(
    withFakeAcpx('duplicate-id', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_protocol_invalid',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.result, undefined);
});

test('DSH rejects a terminal response with a mismatched session id', async () => {
  const value = await fixture({ provider: 'dsh', id: 'dsh-wrong-result-session' });
  await assert.rejects(
    withFakeAcpx('wrong-result-session', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_invalid_result',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.result, undefined);
  assert.equal(task.dispatch_uncertain, true);
});

test('DSH does not fall back after ACPX has spawned without an acknowledgement', async () => {
  const cliMarker = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-cli-'))), 'cli-ran');
  const value = await fixture({
    provider: 'dsh',
    id: 'dsh-uncertain-spawn',
    cliArgv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cliMarker)}, 'ran')`],
  });
  await assert.rejects(
    withFakeAcpx('fail-after-spawn', () => runAcpTask({ root: value.root, taskId: value.taskId })),
    (error) => error.code === 'acpx_failed',
  );
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_safe, false);
  await assert.rejects(access(cliMarker));
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).includes('acpx-home'), false);
});

test('DSH Ox Alpha fails closed instead of using a model-blind pre-spawn CLI fallback', async () => {
  const value = await fixture({
    provider: 'dsh',
    dshModel: 'stealth/ox-alpha',
    id: 'dsh-ox-pre-spawn-failure',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("SHOULD_NOT_RUN")'],
  });
  const previous = process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = '/definitely/missing/acpx';
  try {
    await assert.rejects(
      runAcpTask({ root: value.root, taskId: value.taskId }),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
    else process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = previous;
  }
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.transport, 'acp');
  assert.equal(task.dsh_model, 'stealth/ox-alpha');
  assert.equal(task.prompt_dispatched, undefined);
  assert.equal(task.fallback_from, undefined);
  assert.equal(task.fallback_safe, false);
  assert.notEqual(task.result, 'SHOULD_NOT_RUN');
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(events, /acp_failed_before_dispatch|"transport":"cli"|SHOULD_NOT_RUN/u);
});

test('DSH Muse still allows pre-spawn CLI fallback when ACPX cannot start', async () => {
  const value = await fixture({
    provider: 'dsh',
    dshModel: 'meta/muse-spark-1.3-contributor',
    id: 'dsh-muse-pre-spawn-fallback',
    cliArgv: [process.execPath, '-e', 'process.stdout.write("MUSE_CLI_FALLBACK_OK")'],
  });
  const previous = process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
  process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = '/definitely/missing/acpx';
  try {
    const terminal = await runAcpTask({ root: value.root, taskId: value.taskId });
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.result, 'MUSE_CLI_FALLBACK_OK');
  } finally {
    if (previous === undefined) delete process.env.CODEX_CO_ENGINEER_ACPX_COMMAND;
    else process.env.CODEX_CO_ENGINEER_ACPX_COMMAND = previous;
  }
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'completed');
  assert.equal(task.transport, 'cli');
  assert.equal(task.dsh_model, 'meta/muse-spark-1.3-contributor');
  assert.equal(task.fallback_from, 'acp');
  assert.equal(task.prompt_dispatched, true);
  assert.equal(task.fallback_safe, false);
  const events = await readFile(path.join(value.root, 'tasks', value.taskId, 'events.jsonl'), 'utf8');
  assert.match(events, /acp_failed_before_dispatch/u);
  assert.match(events, /"transport":"cli"/u);
});

test('DSH deadline kills a detached ACPX descendant before terminalizing', async () => {
  const descendantPidFile = path.join((await mkdtemp(path.join(tmpdir(), 'co-engineer-v3-dsh-tree-'))), 'descendant.pid');
  const value = await fixture({ provider: 'dsh', id: 'dsh-timeout-tree', timeoutMs: 1_000 });
  await assert.rejects(
    withFakeAcpx('timeout-tree', () => runAcpTask({ root: value.root, taskId: value.taskId }), { descendantPidFile }),
    (error) => error.code === 'timeout',
  );
  const pid = Number((await readFile(descendantPidFile, 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  assert.equal(await processExited(pid), true);
  const { task } = await readTask(value.root, value.taskId);
  assert.equal(task.status, 'timeout');
  assert.equal(task.dispatch_uncertain, true);
  assert.equal(task.fallback_safe, false);
  assert.equal((await readdir(path.join(value.root, 'tasks', value.taskId))).includes('acpx-home'), false);
});

test('worker permission handling persists question text and resumes through the mailbox reply', async () => {
  const value = await fixture({ id: 'perm-question' });
  const controller = new AbortController();
  const question = 'Which environment should I use?';
  const options = [
    { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
  ];
  const pending = handlePermissionRequest(value.root, value.taskId, {
    sessionId: 'fake-session-question',
    inferredKind: 'other',
    raw: {
      question,
      toolCall: { toolCallId: 'question-environment', title: 'Ask operator' },
      options,
    },
  }, controller.signal);
  try {
    const deadline = Date.now() + 1_000;
    let attention;
    while (Date.now() < deadline) {
      const current = (await readTask(value.root, value.taskId)).task;
      if (current.status === 'needs_attention') {
        attention = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(attention?.status, 'needs_attention');
    const stored = JSON.parse(await readFile(
      path.join(value.root, 'tasks', value.taskId, 'attention.json'),
      'utf8',
    ));
    assert.equal(stored.prompt, question);
    assert.deepEqual(stored.options, options);
    await submitReply(value.root, value.taskId, {
      session_id: attention.attention.session_id,
      question_id: attention.attention.question_id,
      response: { optionId: 'allow' },
    });
    assert.deepEqual(await pending, { outcome: 'allow_once', optionId: 'allow' });
    assert.equal((await readTask(value.root, value.taskId)).task.status, 'running');
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test('title-only ACP questions persist and continue the real worker session', async () => {
  const controller = new AbortController();
  let running;
  try {
    const question = 'Which environment should I use?';
    const value = await fixture({
      prompt: 'need permission title question please',
      id: 'perm-title-question',
      timeoutMs: 8_000,
    });
    running = runAcpTask({ root: value.root, taskId: value.taskId, signal: controller.signal });
    const deadline = Date.now() + 5_000;
    let attention;
    while (Date.now() < deadline) {
      const current = (await readTask(value.root, value.taskId)).task;
      if (current.status === 'needs_attention') {
        attention = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(attention?.status, 'needs_attention');
    const stored = JSON.parse(await readFile(
      path.join(value.root, 'tasks', value.taskId, 'attention.json'),
      'utf8',
    ));
    assert.equal(stored.prompt, question);
    await submitReply(value.root, value.taskId, {
      session_id: attention.attention.session_id,
      question_id: attention.attention.question_id,
      response: { optionId: 'allow' },
    });
    assert.equal((await running).status, 'completed');
  } finally {
    controller.abort();
    await running?.catch(() => {});
  }
});
