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

test('native form sends a bounded request and accepts only accept plus approved true', async () => {
  const { instance, sent } = transport();
  const pending = instance.requestConsent(compiled());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, NATIVE_CONSENT_METHOD);
  assert.equal(sent[0].params.mode, 'form');
  assert.match(sent[0].params.message, /Repository: \/tmp\/consent-repository/u);
  assert.match(sent[0].params.message, /Base SHA: 0123456789abcdef0123456789abcdef01234567/u);
  assert.match(sent[0].params.message, /full repository and Git history/u);
  assert.match(sent[0].params.message, /this run only/u);
  assert.match(sent[0].params.message, /Remote mutations: none/u);
  assert.deepEqual(sent[0].params.requestedSchema.required, ['approved']);
  assert.equal(sent[0].params.requestedSchema.properties.approved.type, 'boolean');
  assert.equal(sent[0].params.requestedSchema.properties.approved.default, false);

  assert.equal(instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[0].id,
    result: { action: 'accept', content: { approved: true } },
  }), true);
  assert.deepEqual(await pending, { approved: true });
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
    result: { action: 'accept', content: { approved: true } },
  }), true);
  assert.equal(instance.pendingCount, 1);
  instance.handleMessage({
    jsonrpc: '2.0',
    id: newId,
    result: { action: 'accept', content: { approved: false } },
  });
  assert.deepEqual(await reopened, { status: 'blocked', code: 'consent_declined' });

  const malformed = instance.requestConsent(compiled('malformed-run'));
  instance.handleMessage({
    jsonrpc: '2.0',
    id: sent[2].id,
    result: { action: 'accept', content: { approved: true, extra: 'nope' } },
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
    result: { action: 'accept', content: { approved: true } } });
  assert.deepEqual(await pending, { status: 'blocked', code: 'consent_response_invalid' });
});

test('concurrent responses and cancellation stay bound to their run', async () => {
  const { instance, sent } = transport();
  const first = instance.requestConsent(compiled('first-run'));
  const second = instance.requestConsent(compiled('second-run'));
  instance.cancelRun('first-run');
  instance.handleMessage({ jsonrpc: '2.0', id: sent[0].id,
    result: { action: 'accept', content: { approved: true } } });
  assert.equal(instance.pendingCount, 1);
  instance.handleMessage({ jsonrpc: '2.0', id: sent[1].id,
    result: { action: 'accept', content: { approved: true } } });
  assert.deepEqual(await first, { status: 'required', code: 'consent_cancelled' });
  assert.deepEqual(await second, { approved: true });
  assert.equal(instance.pendingCount, 0);
});
