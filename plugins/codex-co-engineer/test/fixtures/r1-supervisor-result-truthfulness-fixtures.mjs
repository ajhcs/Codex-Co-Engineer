// Neutral fixtures for supervisor result-truthfulness tests. Construction
// only: no Git, filesystem, process, network, provider, or stored-byte writes.

export const AUTHORITATIVE_PING_TIMEOUT = 'RetriableError [unavailable] PING timed out';
export const HOSTILE_SECRET = 'sk-secret-value-do-not-leak';
export const HOSTILE_PATH = '/tmp/secret-repo-do-not-leak';
export const HOSTILE_URL = 'https://evil.example/steal?token=secret';
export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;

export const STORED_STATUS_VOCABULARY = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'environment_blocked',
  'transport_lost',
  'needs_attention',
  'accepted',
  'starting',
  'running',
  'cancelling',
]);

export const PUBLIC_STATE_VOCABULARY = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'environment_blocked',
  'transport_lost',
  'needs_attention',
  'accepted',
  'starting',
  'running',
  'cancelling',
]);

export const LEGACY_STATUS_KEYS = Object.freeze([
  'version',
  'healthy',
  'active',
  'providers',
  'capabilities',
  'mcp_pending_call',
  'local_boundary',
  'readiness',
  'tasks',
]);

export const COMPACT_OMITTED_TASKS_KEYS = Object.freeze([
  ...LEGACY_STATUS_KEYS,
  'detail',
  'task_count',
  'returned_tasks',
  'task_limit',
  'include_tasks',
  'total',
  'limit',
]);

export const TASK_STATUS_KEYS = Object.freeze([
  'task',
  'runtime',
  'progress',
  'state',
  'summary',
  'diagnostic',
  'capabilities',
  'view',
]);

export function readyBoundary() {
  return {
    ready: true,
    status: 'prerequisites_ready',
    provider_started: false,
    boundary: 'systemd-user-service-cgroup',
  };
}

export function readyProviderReadiness() {
  return {
    grok: { installed: true, ready: true, transport: 'acp' },
    'cursor-local': { installed: true, ready: true, transport: 'acp' },
    dsh: { installed: true, ready: true, transport: 'acpx' },
    'cursor-cloud': { installed: true, ready: true, transport: 'cursor-sdk' },
  };
}

export function terminalReceipt(overrides = {}) {
  return {
    id: 'rtruth-terminal',
    status: 'completed',
    provider: 'cursor-local',
    role: 'implement',
    prompt_dispatched: true,
    finished_at: '2026-08-25T00:00:00.000Z',
    stop_reason: 'end_turn',
    result: 'implemented the requested change',
    ...overrides,
  };
}

export function zeroWorkPingTimeoutReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-ping-timeout',
    result: AUTHORITATIVE_PING_TIMEOUT,
    error: {
      code: 'unavailable',
      name: 'RetriableError',
      message: AUTHORITATIVE_PING_TIMEOUT,
    },
    ...overrides,
  });
}

export function wholeResultPingTimeoutReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-whole-result-ping',
    result: AUTHORITATIVE_PING_TIMEOUT,
    error: null,
    ...overrides,
  });
}

export function envelopeOnlyCompletedReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-envelope-only',
    result: null,
    error: {
      code: 'unavailable',
      name: 'RetriableError',
      message: AUTHORITATIVE_PING_TIMEOUT,
    },
    ...overrides,
  });
}

export function structuredWholeResultErrorReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-structured-result',
    result: {
      name: 'RetriableError',
      code: 'unavailable',
      message: AUTHORITATIVE_PING_TIMEOUT,
    },
    error: null,
    ...overrides,
  });
}

export function legitimateCompletedReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-legitimate-completed',
    result: 'The change is on the branch with tests passing.',
    error: null,
    ...overrides,
  });
}

export function quotedPingInSuccessfulResultReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-quoted-ping',
    result: [
      'Review notes:',
      '- retry the later probe if a prior PING timed out in logs',
      '- the requested implementation is complete',
    ].join('\n'),
    error: null,
    ...overrides,
  });
}

export function countingProxy(target) {
  const counts = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, has: 0, apply: 0 };
  const proxy = new Proxy(target, {
    get(inner, property, receiver) {
      counts.get += 1;
      return Reflect.get(inner, property, receiver);
    },
    ownKeys(inner) {
      counts.ownKeys += 1;
      return Reflect.ownKeys(inner);
    },
    getOwnPropertyDescriptor(inner, property) {
      counts.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
    has(inner, property) {
      counts.has += 1;
      return Reflect.has(inner, property);
    },
    apply() {
      counts.apply += 1;
      throw new Error('proxy apply must never run');
    },
  });
  return { proxy, counts };
}

export function throwingGetterReceipt(field, overrides = {}) {
  const base = terminalReceipt({
    id: `rtruth-throwing-${field}`,
    ...overrides,
  });
  return new Proxy(base, {
    get(inner, property, receiver) {
      if (property === field) throw new Error(`${field} accessor must not leak ${HOSTILE_SECRET}`);
      return Reflect.get(inner, property, receiver);
    },
  });
}
