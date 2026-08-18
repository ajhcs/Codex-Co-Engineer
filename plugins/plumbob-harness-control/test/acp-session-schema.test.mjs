import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACP_SESSION_INPUT_SCHEMA,
  ACP_SESSION_LIMITS,
  ACP_SESSION_SCHEMA_VERSION,
  AcpSessionSchemaError,
  acpSessionRequestFingerprint,
  isAcpSessionMutation,
  projectAcpSessionResponse,
  validateAcpSessionRequest,
} from '../mcp/acp-session-schema.mjs';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const targetContext = {
  schema_version: 'codex-co-engineer.target.v1',
  mode: 'explicit',
  working_directory: '/repository',
  expected_git_root: '/repository',
  expected_head: 'b'.repeat(40),
  allowed_paths: ['.'],
  role: 'review',
};
const target = { ...targetContext, target_fingerprint: fingerprint };

function request(action, fields = {}) {
  return {
    schema_version: ACP_SESSION_SCHEMA_VERSION,
    action,
    target_context: targetContext,
    expected_target_fingerprint: fingerprint,
    ...fields,
  };
}

test('all seven strict action variants validate and create never accepts a prompt', () => {
  const cases = [
    request('create', { provider: 'grok-local-acp', request_id: 'request-0001' }),
    request('prompt', { session_id: 'session-0001', request_id: 'request-0002', prompt: 'Review this.' }),
    request('stream', { session_id: 'session-0001', turn_id: 'turn-0000001', after_seq: 0 }),
    request('cancel', { session_id: 'session-0001', turn_id: 'turn-0000001', request_id: 'request-0003' }),
    request('resume', { session_id: 'session-0001', request_id: 'request-0004' }),
    request('config', { session_id: 'session-0001', request_id: 'request-0005', provider: 'cursor-local-acp', config: { max_turns: 8 } }),
    request('close', { session_id: 'session-0001', request_id: 'request-0006' }),
  ];
  for (const candidate of cases) assert.equal(validateAcpSessionRequest(candidate, target).action, candidate.action);
  assert.throws(
    () => validateAcpSessionRequest({ ...cases[0], prompt: 'confused deputy' }, target),
    (error) => error instanceof AcpSessionSchemaError && error.code === 'unknown_field',
  );
  assert.equal(ACP_SESSION_INPUT_SCHEMA.oneOf.length, 7);
  assert.equal(ACP_SESSION_INPUT_SCHEMA.oneOf.every((variant) => variant.additionalProperties === false), true);
  for (const action of ['create', 'config']) {
    const variant = ACP_SESSION_INPUT_SCHEMA.oneOf.find((entry) => entry.properties.action.const === action);
    assert.equal(variant.allOf.every((condition) => condition.then.properties.config.additionalProperties === false), true);
  }
});

test('unknown, path, command, raw config, MCP, and branch-like fields fail closed', () => {
  const base = request('create', {
    provider: 'grok-local-acp', request_id: 'request-0001',
  });
  for (const field of ['working_directory', 'path', 'argv', 'env', 'mcp', 'raw_config', 'branch_mode', 'branch_name']) {
    assert.throws(
      () => validateAcpSessionRequest({ ...base, [field]: field }, target),
      (error) => error.code === 'unknown_field' && error.field === `request.${field}`,
    );
  }
  assert.throws(
    () => validateAcpSessionRequest({ ...base, target_context: { ...targetContext, branch_mode: 'new' } }, target),
    (error) => error.code === 'unknown_field' && error.field === 'target_context.branch_mode',
  );
  for (const field of ['command', 'env', 'argv', 'path', 'mcp_servers', 'raw_config', 'branch_mode']) {
    assert.throws(
      () => validateAcpSessionRequest({ ...base, config: { [field]: 'no' } }, target),
      (error) => error.code === 'unknown_field',
    );
  }
});

test('discriminated provider configs do not cross-accept options', () => {
  const base = { request_id: 'request-0001' };
  const grok = validateAcpSessionRequest(request('create', {
    ...base,
    provider: 'grok-local-acp',
    config: { model: 'grok-4.6', reasoning_effort: 'max', delegation: true },
  }), target);
  assert.equal(grok.config.reasoning_effort, 'max');
  const cursor = validateAcpSessionRequest(request('create', {
    ...base,
    provider: 'cursor-local-acp',
    config: { model: 'cursor-default', allowed_tools: ['read', 'grep'], max_turns: 64 },
  }), target);
  assert.deepEqual(cursor.config.allowed_tools, ['read', 'grep']);
  assert.throws(
    () => validateAcpSessionRequest(request('create', {
      ...base, provider: 'grok-local-acp', config: { allowed_tools: ['read'] },
    }), target),
    (error) => error.code === 'unknown_field',
  );
  assert.throws(
    () => validateAcpSessionRequest(request('create', {
      ...base, provider: 'cursor-local-acp', config: { delegation: true },
    }), target),
    (error) => error.code === 'unknown_field',
  );
});

test('prompt bounds count UTF-8 bytes, Unicode validity, NUL, and physical lines', () => {
  const base = { session_id: 'session-0001', request_id: 'request-0002' };
  const exactAscii = 'a'.repeat(ACP_SESSION_LIMITS.prompt_bytes);
  assert.equal(validateAcpSessionRequest(request('prompt', { ...base, prompt: exactAscii }), target).prompt.length, exactAscii.length);
  assert.throws(
    () => validateAcpSessionRequest(request('prompt', { ...base, prompt: '💚'.repeat((ACP_SESSION_LIMITS.prompt_bytes / 4) + 1) }), target),
    (error) => error.code === 'prompt_too_large',
  );
  assert.throws(
    () => validateAcpSessionRequest(request('prompt', { ...base, prompt: `${'x\n'.repeat(ACP_SESSION_LIMITS.prompt_lines)}x` }), target),
    (error) => error.code === 'prompt_too_many_lines',
  );
  for (const separator of ['\r', '\n', '\r\n']) {
    const exactLines = Array.from({ length: ACP_SESSION_LIMITS.prompt_lines }, () => 'x').join(separator);
    assert.equal(validateAcpSessionRequest(request('prompt', { ...base, prompt: exactLines }), target).prompt, exactLines);
    const tooManyLines = `${exactLines}${separator}x`;
    assert.throws(
      () => validateAcpSessionRequest(request('prompt', { ...base, prompt: tooManyLines }), target),
      (error) => error.code === 'prompt_too_many_lines',
    );
  }
  for (const invalid of ['bad\u0000prompt', '\ud800']) {
    assert.throws(() => validateAcpSessionRequest(request('prompt', { ...base, prompt: invalid }), target), /prompt/i);
  }
});

test('authoritative role cannot be supplied in-band, omitted role inherits, and escalation fails', () => {
  const base = request('create', { provider: 'grok-local-acp', request_id: 'request-0001' });
  const implementContext = { ...targetContext, role: 'implement' };
  const implementAuthority = { ...implementContext, target_fingerprint: fingerprint };
  assert.equal(validateAcpSessionRequest({ ...base, target_context: implementContext }, implementAuthority).role, 'implement');
  assert.equal(validateAcpSessionRequest({ ...base, role: 'review' }, target).role, 'review');
  assert.throws(() => validateAcpSessionRequest({ ...base, role: 'implement' }, target), (error) => error.code === 'role_escalation');
  assert.throws(() => validateAcpSessionRequest(base), (error) => error.code === 'target_authority_required');
  assert.throws(
    () => validateAcpSessionRequest({ ...base, target_context: implementContext }, target),
    (error) => error.code === 'target_authority_mismatch',
  );
});

test('managed IDs, exact lowercase prefixed digest, and stream bounds are enforced', () => {
  assert.throws(
    () => validateAcpSessionRequest(request('stream', { session_id: '/tmp/x', turn_id: 'turn-0000001', after_seq: 0 }), target),
    (error) => error.code === 'invalid_id',
  );
  assert.throws(
    () => validateAcpSessionRequest(request('resume', { session_id: 'session-0001', request_id: 'request-0001', expected_target_fingerprint: 'a'.repeat(64) }), target),
    (error) => error.code === 'invalid_target_fingerprint',
  );
  for (const fields of [
    { after_seq: -1 },
    { after_seq: 0, max_events: 201 },
    { after_seq: 0, max_bytes: 65_537 },
  ]) {
    assert.throws(
      () => validateAcpSessionRequest(request('stream', { session_id: 'session-0001', turn_id: 'turn-0000001', ...fields }), target),
      (error) => error.code === 'invalid_page',
    );
  }
  const page = validateAcpSessionRequest(request('stream', { session_id: 'session-0001', turn_id: 'turn-0000001', after_seq: 12 }), target);
  assert.equal(page.max_events, 200);
  assert.equal(page.max_bytes, 65_536);
});

test('mutation classifier treats stream as the sole read-only action', () => {
  for (const action of ['create', 'prompt', 'cancel', 'resume', 'config', 'close']) {
    assert.equal(isAcpSessionMutation(action), true);
    assert.equal(isAcpSessionMutation({ action }), true);
  }
  assert.equal(isAcpSessionMutation('stream'), false);
  assert.equal(isAcpSessionMutation('unknown'), false);
});

test('compact projections drop prompts, provider IDs, raw frames, credentials, and paths', () => {
  const projected = projectAcpSessionResponse('create', {
    session_id: 'session-0001',
    request_id: 'request-0001',
    provider: 'grok-local-acp',
    state: 'ready',
    prompt: 'secret prompt',
    provider_session_id: 'provider-secret',
    raw_frame: { private: true },
    credentials: { token: 'secret' },
    cwd: '/private/repository',
  });
  assert.deepEqual(projected, {
    schema_version: ACP_SESSION_SCHEMA_VERSION,
    action: 'create',
    session_id: 'session-0001',
    request_id: 'request-0001',
    state: 'ready',
    provider: 'grok-local-acp',
  });
  assert.equal(JSON.stringify(projected).includes('secret'), false);

  const stream = projectAcpSessionResponse('stream', {
    session_id: 'session-0001', turn_id: 'turn-0000001', after_seq: 0, next_seq: 300,
    events: Array.from({ length: 300 }, (_, index) => ({
      seq: index + 1,
      type: 'text',
      text: index === 0 ? 'sensitive-marker-abcdefghijklmnop at C:/Users/name/token' : 'x'.repeat(20_000),
      raw: 'secret',
    })),
  });
  assert.equal(stream.events.length <= ACP_SESSION_LIMITS.stream_events, true);
  assert.equal(Buffer.byteLength(JSON.stringify(stream), 'utf8') <= ACP_SESSION_LIMITS.stream_bytes, true);
  assert.equal(JSON.stringify(stream).includes('secret'), false);
  assert.equal(JSON.stringify(stream).includes('sensitive-marker-'), false);
  assert.equal(JSON.stringify(stream).includes('C:/Users'), false);
  assert.equal(stream.events.every((event) => !Object.hasOwn(event, 'text')), true);
  assert.equal(stream.has_more, true);
  assert.equal(stream.next_seq, stream.events.at(-1).seq);
  assert.equal(stream.next_seq < 300, true);
});

test('stream projection rejects stale, duplicate, decreasing, and regressing cursors', () => {
  const base = { session_id: 'session-0001', turn_id: 'turn-0000001', after_seq: 10 };
  for (const value of [
    { ...base, events: [{ seq: 10, type: 'text', text: 'stale' }], next_seq: 10 },
    { ...base, events: [{ seq: 11, type: 'text' }, { seq: 11, type: 'text' }], next_seq: 11 },
    { ...base, events: [{ seq: 12, type: 'text' }, { seq: 11, type: 'text' }], next_seq: 12 },
    { ...base, events: [{ seq: 11, type: 'text' }], next_seq: 10 },
  ]) {
    assert.throws(
      () => projectAcpSessionResponse('stream', value),
      (error) => error.code === 'invalid_response_cursor',
    );
  }
  const valid = projectAcpSessionResponse('stream', {
    ...base,
    events: [{ seq: 11, type: 'text' }, { seq: 13, type: 'status' }],
    next_seq: 13,
  });
  assert.deepEqual(valid.events.map((event) => event.seq), [11, 13]);
});

test('response projection does not reflect arbitrary provider or metadata strings', () => {
  assert.throws(
    () => projectAcpSessionResponse('create', { provider: '/private/provider-token' }),
    (error) => error.code === 'invalid_response' && error.field === 'provider',
  );
  const projected = projectAcpSessionResponse('create', {
    provider: 'cursor-local-acp',
    state: 'sensitive-marker-abcdefghijklmnop',
    status: 'C:/Users/name/token',
    error_code: 'TOKEN=secret value',
    effective_model: '/private/model path',
    path: '/private/repository',
    secret: 'credential',
  });
  assert.deepEqual(projected, {
    schema_version: ACP_SESSION_SCHEMA_VERSION,
    action: 'create',
    provider: 'cursor-local-acp',
  });
});

test('every action requires the existing target_context and exact target fingerprint binding', () => {
  for (const action of ['create', 'prompt', 'stream', 'cancel', 'resume', 'config', 'close']) {
    const variant = ACP_SESSION_INPUT_SCHEMA.oneOf.find((entry) => entry.properties.action.const === action);
    assert.equal(variant.required.includes('target_context'), true);
    assert.equal(variant.required.includes('expected_target_fingerprint'), true);
  }
  const base = request('close', { session_id: 'session-0001', request_id: 'request-0001' });
  const { target_context: _omitted, ...withoutTarget } = base;
  assert.throws(() => validateAcpSessionRequest(withoutTarget, target), (error) => error.code === 'missing_field');
  assert.throws(
    () => validateAcpSessionRequest(base, { ...target, target_fingerprint: `sha256:${'c'.repeat(64)}` }),
    (error) => error.code === 'target_fingerprint_mismatch',
  );
});

test('request fingerprints bind create authority and prompt digest without retaining prompt text', () => {
  const create = validateAcpSessionRequest(request('create', {
    provider: 'grok-local-acp',
    request_id: 'request-0001',
    config: { model: 'grok-4.6', reasoning_effort: 'max' },
  }), target);
  const createReceipt = acpSessionRequestFingerprint(create);
  assert.equal(createReceipt.material.provider, 'grok-local-acp');
  assert.equal(createReceipt.material.expected_target_fingerprint, fingerprint);
  assert.equal(createReceipt.material.role, 'review');
  const differentConfig = acpSessionRequestFingerprint({
    ...create,
    config: { ...create.config, reasoning_effort: 'high' },
  });
  assert.notEqual(createReceipt.fingerprint, differentConfig.fingerprint);

  const promptText = 'private prompt body';
  const promptRequest = validateAcpSessionRequest(request('prompt', {
    session_id: 'session-0001', request_id: 'request-0002', prompt: promptText,
  }), target);
  const promptReceipt = acpSessionRequestFingerprint(promptRequest);
  assert.equal(promptReceipt.material.session_id, 'session-0001');
  assert.equal(promptReceipt.material.expected_target_fingerprint, fingerprint);
  assert.match(promptReceipt.material.prompt_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(promptReceipt).includes(promptText), false);
  assert.notEqual(
    promptReceipt.fingerprint,
    acpSessionRequestFingerprint({ ...promptRequest, prompt: `${promptText}!` }).fingerprint,
  );
});

test('caller target fields cannot diverge from preflight authority', () => {
  const base = request('close', { session_id: 'session-0001', request_id: 'request-0001' });
  for (const forgedTarget of [
    { ...targetContext, working_directory: '/evil' },
    { ...targetContext, expected_git_root: '/evil' },
    { ...targetContext, expected_head: 'c'.repeat(40) },
    { ...targetContext, allowed_paths: ['/'] },
  ]) {
    assert.throws(
      () => validateAcpSessionRequest({ ...base, target_context: forgedTarget }, target),
      (error) => error.code === 'target_authority_mismatch',
    );
  }
  const normalized = validateAcpSessionRequest(base, {
    ...target,
    resolved_workspace: '/repository',
    workspace_identity: { dev: 1, ino: 2 },
  });
  assert.equal(normalized.target_context.resolved_workspace, '/repository');
  assert.deepEqual(normalized.target_context.workspace_identity, { dev: 1, ino: 2 });
  assert.notEqual(normalized.target_context, base.target_context);
});

test('all effect-bearing mutation fields participate in request fingerprints', () => {
  const grokConfig = validateAcpSessionRequest(request('config', {
    session_id: 'session-0001',
    request_id: 'request-0001',
    provider: 'grok-local-acp',
    config: { model: 'shared-model', reasoning_effort: 'high' },
  }), target);
  const cursorConfig = validateAcpSessionRequest(request('config', {
    session_id: 'session-0001',
    request_id: 'request-0002',
    provider: 'cursor-local-acp',
    config: { model: 'shared-model', max_turns: 8 },
  }), target);
  assert.notEqual(
    acpSessionRequestFingerprint(grokConfig).fingerprint,
    acpSessionRequestFingerprint(cursorConfig).fingerprint,
  );
  assert.notEqual(
    acpSessionRequestFingerprint(grokConfig).fingerprint,
    acpSessionRequestFingerprint({
      ...grokConfig,
      config: { ...grokConfig.config, reasoning_effort: 'max' },
    }).fingerprint,
  );

  const verifyContext = { ...targetContext, role: 'verify' };
  const verifyAuthority = { ...target, role: 'verify' };
  const reviewClose = validateAcpSessionRequest(request('close', {
    session_id: 'session-0001', request_id: 'request-0003',
  }), target);
  const verifyClose = validateAcpSessionRequest(request('close', {
    session_id: 'session-0001', request_id: 'request-0004', target_context: verifyContext,
  }), verifyAuthority);
  assert.notEqual(
    acpSessionRequestFingerprint(reviewClose).fingerprint,
    acpSessionRequestFingerprint(verifyClose).fingerprint,
  );
});

test('public prompt schema declares authoritative byte, Unicode, NUL, and line validation', () => {
  const promptVariant = ACP_SESSION_INPUT_SCHEMA.oneOf.find((entry) => entry.properties.action.const === 'prompt');
  const schema = promptVariant.properties.prompt;
  assert.equal(ACP_SESSION_INPUT_SCHEMA['x-authoritative-validator'], 'validateAcpSessionRequest');
  assert.equal(schema['x-authoritative-validator'], 'validateAcpSessionRequest');
  assert.equal(schema['x-content-encoding'], 'utf-8');
  assert.equal(schema['x-max-utf8-bytes'], ACP_SESSION_LIMITS.prompt_bytes);
  assert.equal(schema['x-max-physical-lines'], ACP_SESSION_LIMITS.prompt_lines);
  assert.equal(schema['x-reject-nul'], true);
  assert.equal(schema['x-reject-unpaired-surrogates'], true);
  assert.match(schema.description, /authoritative.*UTF-8 bytes.*physical lines/i);
});
