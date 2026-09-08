// Construction-only fixtures for the declarative provider-event-rules engine.
// Tests own assertions. Helpers never rank, substitute, or invoke getters.

import {
  PROVIDER_EVENT_RULES_SCHEMA_ID,
  PROVIDER_EVENT_RULES_VERSION,
} from '../../mcp/v3/provider-event-rules.mjs';

export const HOSTILE_SECRET = 'ATTACKER-SECRET';
export const HOSTILE_TOKEN = 'sk-live-not-a-real-key-abcdefghijklmnop';
export const HOSTILE_BEARER = 'Bearer supersecrettokenvalue';
export const HOSTILE_URL = 'https://user:hunter2@example.invalid/path';
export const HOSTILE_ENV = 'API_KEY=super-secret-value';

export const IDENTITY = Object.freeze({
  provider: 'grok',
  session_id: 'sess-event-1',
  task_id: 'task-event-1',
  attempt: 1,
});

export const IDENTITY_ATTEMPT_2 = Object.freeze({
  ...IDENTITY,
  attempt: 2,
});

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
    apply(inner, thisArg, args) {
      counts.apply += 1;
      return Reflect.apply(inner, thisArg, args);
    },
  });
  return { proxy, counts };
}

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}

export function rulesDocument(rules) {
  return {
    schema: PROVIDER_EVENT_RULES_SCHEMA_ID,
    version: PROVIDER_EVENT_RULES_VERSION,
    rules,
  };
}

export function textRule(overrides = {}) {
  return {
    id: 'assistant-text',
    kind: 'text',
    type: 'assistant',
    type_path: '/type',
    value_path: '/text',
    ...overrides,
  };
}

export function thinkingRule(overrides = {}) {
  return {
    id: 'thinking',
    kind: 'thinking',
    type: 'thinking',
    type_path: '/type',
    value_path: '/text',
    ...overrides,
  };
}

export function toolRule(overrides = {}) {
  return {
    id: 'tool-call',
    kind: 'tool',
    type: 'tool',
    type_path: '/type',
    value_path: '/tool',
    name_path: '/tool/name',
    ...overrides,
  };
}

export function usageRule(overrides = {}) {
  return {
    id: 'usage',
    kind: 'usage',
    type: 'usage',
    type_path: '/type',
    value_path: '/usage',
    ...overrides,
  };
}

export function questionRule(overrides = {}) {
  return {
    id: 'ask-user',
    kind: 'question',
    type: 'question',
    type_path: '/type',
    value_path: '/text',
    question_id_path: '/question_id',
    signal: 'question',
    ...overrides,
  };
}

export function errorRule(overrides = {}) {
  return {
    id: 'provider-error',
    kind: 'error',
    type: 'error',
    type_path: '/type',
    value_path: '/error',
    signal: 'failed',
    ...overrides,
  };
}

export function signalRule(id, type, signal, kind = 'text') {
  return {
    id,
    kind,
    type,
    type_path: '/type',
    value_path: '/text',
    signal,
  };
}

export function catalogRules() {
  return rulesDocument([
    textRule(),
    thinkingRule(),
    toolRule(),
    usageRule(),
    questionRule(),
    errorRule(),
    signalRule('sig-completed', 'completed', 'completed'),
    signalRule('sig-blocked', 'blocked', 'blocked'),
    signalRule('sig-timeout', 'timeout', 'timeout'),
    signalRule('sig-user-update', 'user_update', 'user_update'),
    signalRule('sig-merge-ready', 'merge_ready', 'merge_ready'),
  ]);
}

export function progressRules() {
  return rulesDocument([textRule()]);
}

export function event(type, extra = {}) {
  return { type, ...extra };
}

export function assistantEvent(text = 'hello from the lane', extra = {}) {
  return event('assistant', { text, ...extra });
}

export function jsonl(events) {
  return events.map((entry) => JSON.stringify(entry)).join('\n');
}

export function applyInput(overrides = {}) {
  return {
    rules: catalogRules(),
    identity: { ...IDENTITY },
    source: [assistantEvent()],
    ...overrides,
  };
}

export function liveReplyBridge() {
  return {
    submit() {
      return { ok: true };
    },
  };
}

export function defineAccessor(object, key, read) {
  const clone = { ...object };
  delete clone[key];
  Object.defineProperty(clone, key, {
    enumerable: true,
    configurable: true,
    get: read,
  });
  return clone;
}
