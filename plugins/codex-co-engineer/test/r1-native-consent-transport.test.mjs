import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NATIVE_CONSENT_MAX_PENDING,
  NATIVE_CONSENT_METHOD,
  createNativeConsentTransport,
  supportsNativeForm,
} from '../mcp/v3/consent.mjs';

function compiled(runId = 'consent-run', providers = ['grok', 'cursor-local']) {
  return {
    run_id: runId,
    git: {
      repository_path: '/tmp/consent-repository',
      base_sha: '0123456789abcdef0123456789abcdef01234567',
    },
    assignments: providers.map((provider, index) => ({
      assignment_id: `lane-${index + 1}`,
      provider,
    })),
  };
}

function transport(options = {}) {
  const sent = [];
  const instance = createNativeConsentTransport({
    send: (message) => sent.push(message),
    getCapabilities: () => ({ elicitation: { form: {} } }),
    getProtocolVersion: () => '2025-11-25',
    ...options,
  });
  return { instance, sent };
}

test('native form capability detection fails closed for missing and URL-only clients', () => {
  assert.equal(supportsNativeForm({}), false);
  assert.equal(supportsNativeForm({ elicitation: null }), false);
  assert.equal(supportsNativeForm({ elicitation: false }), false);
  assert.equal(supportsNativeForm({ elicitation: { url: {} } }), false);
  assert.equal(supportsNativeForm({ elicitation: { form: null } }), false);
  assert.equal(supportsNativeForm({ elicitation: {} }), true);
  assert.equal(supportsNativeForm({ elicitation: { form: {} } }), true);
});

test('native form sends a bounded request and Accept approves the explicit duration choice', async () => {
  const { instance, sent } = transport();
  const pending = instance.requestConsent(compiled());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, NATIVE_CONSENT_METHOD);
  assert.equal(sent[0].params.mode, 'form');
  assert.match(sent[0].params.message, /Repository: \/tmp\/consent-repository/u);
  assert.match(sent[0].params.message, /Base SHA: 0123456789abcdef0123456789abcdef01234567/u);
  assert.match(sent[0].params.message, /full repository and Git history/u);
  assert.match(sent[0].params.message, /remember approval/u);
  assert.match(sent[0].params.message, /this run only/u);
  assert.match(sent[0].params.message, /Remote mutations: none/u);
  assert.deepEqual(sent[0].params.requestedSchema.required, ['approval_duration']);
  assert.deepEqual(sent[0].params.requestedSchema.properties.approval_duration.enum,
    ['Remember for this repository and these providers', 'This run only']);
  assert.equal(sent[0].params.requestedSchema.properties.approval_duration.default,
    'Remember for this repository and these providers');

  assert.equal(instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[0].id,
    result: { action: 'accept', content: { approval_duration: 'This run only' } },
  }), true);
  assert.deepEqual(await pending, {
    approved: true, duration: 'this_run_only', source: 'native_form',
  });
  assert.equal(instance.pendingCount, 0);
});

test('decline, malformed, timeout, abort, and cancel are fail-closed and late responses are ignored', async () => {
  const { instance, sent } = transport({ timeoutMs: 25 });
  const declined = instance.requestConsent(compiled('decline-run'));
  instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[0].id,
    result: { action: 'decline' },
  });
  assert.deepEqual(await declined, { status: 'blocked', code: 'consent_declined' });

  const reopened = instance.requestConsent(compiled('decline-run'));
  const oldId = sent[0].id;
  const newId = sent[1].id;
  assert.notEqual(oldId, newId);
  assert.equal(instance.handleMessage({
    jsonrpc: '2.0',
    id: oldId,
    result: { action: 'accept', content: { approval_duration: 'This run only' } },
  }), true);
  assert.equal(instance.pendingCount, 1);
  instance.handleMessage({
    jsonrpc: '2.0',
    id: newId,
    result: { action: 'accept', content: {} },
  });
  assert.deepEqual(await reopened, { status: 'blocked', code: 'consent_response_invalid' });

  const malformed = instance.requestConsent(compiled('malformed-run'));
  instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[2].id,
    result: { action: 'accept', content: { approval_duration: 'This run only', extra: 'nope' } },
  });
  assert.deepEqual(await malformed, { status: 'blocked', code: 'consent_response_invalid' });

  const timed = instance.requestConsent(compiled('timed-run'));
  assert.deepEqual(await timed, { status: 'required', code: 'consent_timed_out' });

  const controller = new AbortController();
  const aborted = instance.requestConsent(compiled('aborted-run'), { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { status: 'required', code: 'consent_request_aborted' });

  const cancelled = instance.requestConsent(compiled('cancelled-run'));
  assert.equal(instance.cancelRun('cancelled-run'), true);
  assert.deepEqual(await cancelled, { status: 'required', code: 'consent_cancelled' });

  assert.equal(instance.handleMessage({
    jsonrpc: '2.0',
    id: 'unknown-id',
    result: { action: 'accept', content: { approved: true } },
  }), true);
});

test('unsupported clients never emit a form and pending consent is bounded', async () => {
  const unsupported = createNativeConsentTransport({
    send: () => assert.fail('unsupported client must not receive a form'),
    getCapabilities: () => ({ elicitation: { url: {} } }),
  });
  assert.deepEqual(await unsupported.requestConsent(compiled()), {
    status: 'blocked',
    code: 'consent_host_unavailable',
  });

  const { instance, sent } = transport({ maxPending: NATIVE_CONSENT_MAX_PENDING });
  const pending = [];
  for (let index = 0; index < NATIVE_CONSENT_MAX_PENDING; index += 1) {
    pending.push(instance.requestConsent(compiled(`bounded-${index}`)));
  }
  assert.equal(sent.length, NATIVE_CONSENT_MAX_PENDING);
  assert.deepEqual(await instance.requestConsent(compiled('overflow-run')), {
    status: 'blocked',
    code: 'consent_host_unavailable',
  });
  instance.close();
  for (const value of pending) {
    assert.deepEqual(await value, { status: 'required', code: 'consent_request_aborted' });
  }
});

test('2025-06-18 form requests omit mode while retaining the standard form schema', async () => {
  const { instance, sent } = transport({ getProtocolVersion: () => '2025-06-18' });
  const pending = instance.requestConsent(compiled('compat-run'));
  assert.equal(Object.hasOwn(sent[0].params, 'mode'), false);
  instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[0].id,
    result: { action: 'cancel' },
  });
  assert.deepEqual(await pending, { status: 'required', code: 'consent_cancelled' });
});


test('a matching id cannot approve through a request-shaped frame', async () => {
  const { instance, sent } = transport();
  const pending = instance.requestConsent(compiled());
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id, method: 'tools/call',
    result: { action: 'accept', content: { approval_duration: 'This run only' } } });
  assert.deepEqual(await pending, { status: 'blocked', code: 'consent_response_invalid' });
});

test('concurrent responses and cancellation stay bound to their run', async () => {
  const { instance, sent } = transport();
  const first = instance.requestConsent(compiled('first-run'));
  const second = instance.requestConsent(compiled('second-run'));
  instance.cancelRun('first-run');
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'accept', content: { approval_duration: 'This run only' } } });
  assert.equal(instance.pendingCount, 1);
  instance.handleMessage({ jsonrpc: '2.0', id: sent[1].id,
    result: { action: 'accept', content: { approval_duration: 'This run only' } } });
  assert.deepEqual(await first, { status: 'required', code: 'consent_cancelled' });
  assert.deepEqual(await second, {
    approved: true, duration: 'this_run_only', source: 'native_form',
  });
  assert.equal(instance.pendingCount, 0);
});

test('remembered approval skips the form and provider expansion asks again', async () => {
  const remembered = {
    approved: true,
    duration: 'repository_and_selected_providers',
    source: 'durable_grant',
    grant_id: 'a'.repeat(64),
  };
  const grantedProviders = new Set(['grok']);
  const { instance, sent } = transport({
    grantStore: {
      resolveIdentity: async () => ({ id: 'repo' }),
      assertIdentityCurrent: async () => true,
      lookup: async ({ providers }) => providers.every((provider) => grantedProviders.has(provider))
        ? remembered : null,
      remember: async () => assert.fail('lookup reuse must not write'),
    },
  });
  assert.deepEqual(await instance.requestConsent(compiled('reuse-run', ['grok'])), remembered);
  assert.equal(sent.length, 0);
  const expanded = instance.requestConsent(compiled('expanded-run', ['grok', 'dsh']));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'decline' } });
  assert.deepEqual(await expanded, { status: 'blocked', code: 'consent_declined' });
});

test('lookup races recheck abort, close, and same-run pending state', async () => {
  let releaseLookup;
  const lookup = new Promise((resolve) => { releaseLookup = resolve; });
  const { instance, sent } = transport({
    grantStore: {
      resolveIdentity: async () => ({ id: 'repo' }),
      assertIdentityCurrent: async () => true,
      lookup: async () => lookup,
      remember: async () => {},
    },
  });
  const first = instance.requestConsent(compiled('raced-run'));
  const second = instance.requestConsent(compiled('raced-run'));
  releaseLookup(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, 'concurrent same-run lookups open one form');
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'accept', content: { approval_duration: 'This run only' } } });
  assert.deepEqual(await first, await second);

  let releaseAborted;
  const abortedLookup = new Promise((resolve) => { releaseAborted = resolve; });
  const aborting = transport({ grantStore: {
    resolveIdentity: async () => ({ id: 'repo' }),
    assertIdentityCurrent: async () => true,
    lookup: async () => abortedLookup,
    remember: async () => {},
  } });
  const controller = new AbortController();
  const aborted = aborting.instance.requestConsent(compiled('lookup-abort'), { signal: controller.signal });
  controller.abort();
  releaseAborted(rememberedResult());
  assert.deepEqual(await aborted, { status: 'required', code: 'consent_request_aborted' });
  assert.equal(aborting.sent.length, 0);
});

function rememberedResult() {
  return {
    approved: true,
    duration: 'repository_and_selected_providers',
    source: 'durable_grant',
  };
}

test('the first host response is consumed before durable persistence settles', async () => {
  let finishRemember;
  let rememberCalls = 0;
  const { instance, sent } = transport({ grantStore: {
    resolveIdentity: async () => ({ id: 'captured' }),
    assertIdentityCurrent: async () => true,
    lookup: async () => null,
    remember: async ({ repositoryIdentity }) => {
      rememberCalls += 1;
      assert.deepEqual(repositoryIdentity, { id: 'captured' });
      return new Promise((resolve) => { finishRemember = resolve; });
    },
  } });
  const pending = instance.requestConsent(compiled('remember-race'));
  await new Promise((resolve) => setImmediate(resolve));
  const response = { jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'accept', content: {
      approval_duration: 'Remember for this repository and these providers',
    } } };
  instance.handleMessage(response);
  instance.handleMessage({ ...response, result: { action: 'decline' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rememberCalls, 1);
  finishRemember();
  assert.deepEqual(await pending, {
    approved: true,
    duration: 'repository_and_selected_providers',
    source: 'native_form',
  });
});

test('cancellation during identity recheck prevents a durable write', async () => {
  let finishIdentityCheck;
  let rememberCalls = 0;
  const { instance, sent } = transport({ grantStore: {
    resolveIdentity: async () => ({ id: 'captured' }),
    lookup: async () => null,
    assertIdentityCurrent: async () => new Promise((resolve) => { finishIdentityCheck = resolve; }),
    remember: async () => { rememberCalls += 1; },
  } });
  const pending = instance.requestConsent(compiled('cancel-before-write'));
  await new Promise((resolve) => setImmediate(resolve));
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'accept', content: {
      approval_duration: 'Remember for this repository and these providers',
    } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.cancelRun('cancel-before-write'), true);
  finishIdentityCheck(true);
  assert.deepEqual(await pending, { status: 'required', code: 'consent_cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rememberCalls, 0);
});

for (const approvalDuration of [
  'Remember for this repository and these providers', 'This run only',
]) {
  test(`repository drift rejects ${approvalDuration} acceptance and remains retryable`, async () => {
    const { instance, sent } = transport({ grantStore: {
      resolveIdentity: async () => ({ id: 'before-form' }),
      lookup: async () => null,
      assertIdentityCurrent: async () => {
        throw Object.assign(new Error('changed'), { code: 'consent_repository_identity_changed' });
      },
      remember: async () => assert.fail('drift must not persist'),
    } });
    const pending = instance.requestConsent(compiled(`drift-${approvalDuration === 'This run only' ? 'once' : 'remember'}`));
    await new Promise((resolve) => setImmediate(resolve));
    instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
      result: { action: 'accept', content: { approval_duration: approvalDuration } } });
    assert.deepEqual(await pending, {
      status: 'required', code: 'consent_repository_identity_changed',
    });
  });
}
