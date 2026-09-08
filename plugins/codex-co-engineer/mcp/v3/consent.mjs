import { randomUUID } from 'node:crypto';

import { MCP_PENDING_CALL_BUDGET_MS } from './contract.mjs';
import {
  CONSENT_GRANT_DURATION,
  CONSENT_RUN_DURATION,
} from './consent-grants.mjs';

export const NATIVE_CONSENT_METHOD = 'elicitation/create';
export const NATIVE_CONSENT_MAX_PENDING = 8;
export const NATIVE_CONSENT_TIMEOUT_MS = 600_000;
export const NATIVE_CONSENT_SUPPORTED_PROTOCOLS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
]);
export const NATIVE_CONSENT_BLOCKED_CODES = Object.freeze([
  'consent_host_unavailable',
  'consent_declined',
  'consent_cancelled',
  'consent_timed_out',
  'consent_response_invalid',
  'consent_request_aborted',
  'consent_grant_store_invalid',
  'consent_repository_identity_changed',
]);

const RUN_ID = /^[a-z][a-z0-9-]{2,63}$/u;
const BASE_SHA = /^[a-f0-9]{40}$/iu;
const MAX_TIMEOUT_MS = MCP_PENDING_CALL_BUDGET_MS;
const ACCEPT_ACTIONS = new Set(['accept', 'decline', 'cancel']);
const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/u;
const REMEMBER_LABEL = 'Remember for this repository and these providers';
const THIS_RUN_LABEL = 'This run only';

const REQUESTED_SCHEMA = Object.freeze({
  type: 'object',
  properties: Object.freeze({
    approval_duration: Object.freeze({
      type: 'string',
      title: 'Remember this approval?',
      description: 'Choose whether to remember access for this repository and exactly these providers. The default remembers it; choose this run only for a one-time approval.',
      enum: Object.freeze([REMEMBER_LABEL, THIS_RUN_LABEL]),
      default: REMEMBER_LABEL,
    }),
  }),
  required: Object.freeze(['approval_duration']),
  additionalProperties: false,
});

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function own(value, key) {
  return isRecord(value) && Object.hasOwn(value, key);
}

export function supportsNativeForm(capabilities) {
  if (!isRecord(capabilities) || !isRecord(capabilities.elicitation)) return false;
  const elicitation = capabilities.elicitation;
  if (own(elicitation, 'form')) return isRecord(elicitation.form);
  return Object.keys(elicitation).length === 0;
}

function consentBinding(compiled) {
  if (!isRecord(compiled) || typeof compiled.run_id !== 'string' || !RUN_ID.test(compiled.run_id)) {
    return null;
  }
  const git = isRecord(compiled.git) ? compiled.git : {};
  const repositoryPath = typeof git.repository_path === 'string'
    ? git.repository_path
    : (typeof compiled.repository_path === 'string' ? compiled.repository_path : null);
  const baseSha = typeof git.base_sha === 'string'
    ? git.base_sha
    : (typeof compiled.base_sha === 'string' ? compiled.base_sha : null);
  if (typeof repositoryPath !== 'string' || repositoryPath.length === 0
    || !repositoryPath.startsWith('/')
    || typeof baseSha !== 'string' || !BASE_SHA.test(baseSha)) {
    return null;
  }
  if (!Array.isArray(compiled.assignments) || compiled.assignments.length < 1
    || compiled.assignments.length > NATIVE_CONSENT_MAX_PENDING) {
    return null;
  }
  const providers = [];
  for (const assignment of compiled.assignments) {
    if (!isRecord(assignment) || typeof assignment.provider !== 'string'
      || !PROVIDER.test(assignment.provider)) return null;
    if (!providers.includes(assignment.provider)) providers.push(assignment.provider);
  }
  return Object.freeze({
    run_id: compiled.run_id,
    repository_path: repositoryPath,
    base_sha: baseSha,
    providers: Object.freeze(providers),
  });
}

function bindingKey(binding) {
  return JSON.stringify([
    binding.run_id,
    binding.repository_path,
    binding.base_sha,
    binding.providers,
  ]);
}

function consentMessage(binding) {
  return [
    `Co-Engineer requests full repository access for run ${binding.run_id}.`,
    `Repository: ${binding.repository_path}`,
    `Base SHA: ${binding.base_sha}`,
    `Selected providers: ${binding.providers.join(', ')}`,
    'Scope: full repository and Git history.',
    'Default: remember approval for this repository and the selected providers.',
    'Alternative: approve this run only.',
    'Adding a provider, changing the repository origin, or recreating the repository asks again.',
    'Remote mutations: none.',
  ].join('\n');
}

function blocked(code) {
  const status = [
    'consent_cancelled', 'consent_timed_out', 'consent_request_aborted',
    'consent_repository_identity_changed',
  ].includes(code)
    ? 'required' : 'blocked';
  return Object.freeze({ status, code });
}

function responseInvalid() {
  return blocked('consent_response_invalid');
}

function validateResult(result) {
  if (!isRecord(result) || typeof result.action !== 'string'
    || !ACCEPT_ACTIONS.has(result.action)) {
    return responseInvalid();
  }
  const hasContent = own(result, 'content');
  if (result.action === 'accept') {
    if (!hasContent || !isRecord(result.content)
      || Object.keys(result.content).length !== 1
      || !own(result.content, 'approval_duration')
      || ![REMEMBER_LABEL, THIS_RUN_LABEL]
        .includes(result.content.approval_duration)) {
      return responseInvalid();
    }
    return Object.freeze({
      approved: true,
      duration: result.content.approval_duration === REMEMBER_LABEL
        ? CONSENT_GRANT_DURATION
        : CONSENT_RUN_DURATION,
      source: 'native_form',
    });
  }
  if (hasContent && result.content !== undefined
    && (!isRecord(result.content) || Object.keys(result.content).length > 0)) {
    return responseInvalid();
  }
  return blocked(result.action === 'decline' ? 'consent_declined' : 'consent_cancelled');
}

function validTimeout(value, fallback) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) return fallback;
  return value;
}

function validPendingLimit(value, fallback) {
  if (!Number.isSafeInteger(value) || value < 1 || value > NATIVE_CONSENT_MAX_PENDING) return fallback;
  return value;
}

function nextRequestId(pending) {
  let requestId;
  do {
    requestId = `cce-consent-${randomUUID()}`;
  } while (pending.has(requestId));
  return requestId;
}

function protocolVersion(options, getProtocolVersion) {
  if (own(options, 'protocolVersion')) return options.protocolVersion;
  return typeof getProtocolVersion === 'function' ? getProtocolVersion() : '2025-11-25';
}

function capabilitiesValue(options, getCapabilities) {
  if (own(options, 'capabilities')) return options.capabilities;
  return typeof getCapabilities === 'function' ? getCapabilities() : null;
}

export function createNativeConsentTransport(options = {}) {
  if (!isRecord(options) || typeof options.send !== 'function') {
    throw new TypeError('createNativeConsentTransport requires a send function.');
  }
  const send = options.send;
  const getCapabilities = options.getCapabilities;
  const getProtocolVersion = options.getProtocolVersion;
  const defaultTimeout = validTimeout(options.timeoutMs, NATIVE_CONSENT_TIMEOUT_MS);
  const maxPending = validPendingLimit(options.maxPending, NATIVE_CONSENT_MAX_PENDING);
  const grantStore = options.grantStore ?? null;
  const pending = new Map();
  const byRun = new Map();
  let closed = false;

  function settle(entry, value) {
    if (pending.get(entry.request_id) !== entry) return false;
    pending.delete(entry.request_id);
    if (byRun.get(entry.binding.run_id) === entry) byRun.delete(entry.binding.run_id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(value);
    return true;
  }

  async function requestConsent(compiled, requestOptions = {}) {
    const binding = consentBinding(compiled);
    const capabilities = capabilitiesValue(requestOptions, getCapabilities);
    const version = protocolVersion(requestOptions, getProtocolVersion);
    if (closed || !supportsNativeForm(capabilities)
      || !NATIVE_CONSENT_SUPPORTED_PROTOCOLS.includes(version)) {
      return blocked('consent_host_unavailable');
    }
    if (binding === null) return responseInvalid();
    const signal = requestOptions?.signal;
    if (signal?.aborted) return blocked('consent_request_aborted');
    const existing = byRun.get(binding.run_id);
    if (existing) {
      return existing.binding_key === bindingKey(binding)
        ? existing.promise
        : responseInvalid();
    }
    let repositoryIdentity = null;
    if (grantStore !== null) {
      let remembered;
      try {
        repositoryIdentity = await grantStore.resolveIdentity(binding.repository_path);
        remembered = await grantStore.lookup({
          repositoryPath: binding.repository_path,
          repositoryIdentity,
          providers: binding.providers,
        });
      } catch {
        return blocked('consent_grant_store_invalid');
      }
      if (closed) return blocked('consent_host_unavailable');
      if (signal?.aborted) return blocked('consent_request_aborted');
      const afterLookup = byRun.get(binding.run_id);
      if (afterLookup) {
        return afterLookup.binding_key === bindingKey(binding)
          ? afterLookup.promise
          : responseInvalid();
      }
      if (remembered?.approved === true
        && remembered.duration === CONSENT_GRANT_DURATION
        && remembered.source === 'durable_grant') return remembered;
    }
    if (pending.size >= maxPending) return blocked('consent_host_unavailable');

    const request_id = nextRequestId(pending);
    const params = {
      message: consentMessage(binding),
      requestedSchema: REQUESTED_SCHEMA,
    };
    if (version !== '2025-06-18') params.mode = 'form';

    let resolvePromise;
    const promise = new Promise((resolve) => { resolvePromise = resolve; });
    const entry = {
      request_id,
      binding,
      binding_key: bindingKey(binding),
      promise,
      resolve: resolvePromise,
      timer: null,
      signal,
      onAbort: null,
      repository_identity: repositoryIdentity,
      responded: false,
    };
    entry.onAbort = () => settle(entry, blocked('consent_request_aborted'));
    pending.set(request_id, entry);
    byRun.set(binding.run_id, entry);
    entry.timer = setTimeout(() => settle(entry, blocked('consent_timed_out')), validTimeout(
      requestOptions?.timeoutMs,
      defaultTimeout,
    ));
    signal?.addEventListener('abort', entry.onAbort, { once: true });
    try {
      send({
        jsonrpc: '2.0',
        id: request_id,
        method: NATIVE_CONSENT_METHOD,
        params,
      });
    } catch {
      settle(entry, blocked('consent_host_unavailable'));
    }
    return promise;
  }

  function handleMessage(message) {
    if (!isRecord(message) || message.jsonrpc !== '2.0') return false;
    const hasResult = own(message, 'result');
    const hasError = own(message, 'error');
    if (!hasResult && !hasError && own(message, 'method')) return false;
    // A response is consumed before the server's method router, including an
    // unmatched/late response, so it cannot trigger an error-response loop.
    if (!hasResult && !hasError) return message.id !== undefined;
    const entry = pending.get(message.id);
    if (!entry) return true;
    if (entry.responded) return true;
    entry.responded = true;
    if (own(message, 'method') || (hasResult && hasError)) {
      settle(entry, responseInvalid());
    } else if (hasError) {
      settle(entry, responseInvalid());
    } else {
      const result = validateResult(message.result);
      if (result.approved === true && grantStore !== null) {
        Promise.resolve(grantStore.assertIdentityCurrent({
          repositoryPath: entry.binding.repository_path,
          repositoryIdentity: entry.repository_identity,
        })).then(async () => {
          if (pending.get(entry.request_id) !== entry) return false;
          if (result.duration === CONSENT_GRANT_DURATION) {
            await grantStore.remember({
              repositoryPath: entry.binding.repository_path,
              repositoryIdentity: entry.repository_identity,
              providers: entry.binding.providers,
            });
          }
          return true;
        }).then((active) => active && settle(entry, result)).catch((error) => {
          const code = error?.code === 'consent_repository_identity_changed'
            ? 'consent_repository_identity_changed'
            : 'consent_grant_store_invalid';
          settle(entry, blocked(code));
        });
      } else if (result.approved === true && result.duration === CONSENT_GRANT_DURATION) {
        settle(entry, blocked('consent_grant_store_invalid'));
      } else {
        settle(entry, result);
      }
    }
    return true;
  }

  function cancelRequest(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    return settle(entry, blocked('consent_request_aborted'));
  }

  function cancelRun(runId) {
    const entry = byRun.get(runId);
    if (!entry) return false;
    return settle(entry, blocked('consent_cancelled'));
  }

  function close(reason = 'disconnect') {
    closed = true;
    const code = 'consent_request_aborted';
    for (const entry of [...pending.values()]) settle(entry, blocked(code));
  }

  return Object.freeze({
    cancelRequest,
    cancelRun,
    close,
    handleMessage,
    requestConsent,
    get pendingCount() { return pending.size; },
    pendingRequestIds: () => Object.freeze([...pending.keys()]),
    supports: () => supportsNativeForm(capabilitiesValue({}, getCapabilities)),
  });
}
