// Shared fixtures for the W14-P16A VerificationPolicyV1 tests.
// Pure data and tiny local helpers; no I/O and no product imports beyond
// the trusted-policy module under test.

export const COMMAND_ID = 'unit-tests';
export const EXECUTABLE = '/usr/bin/npm';

export function validCommand(overrides = {}) {
  return {
    command_id: COMMAND_ID,
    executable: EXECUTABLE,
    argv_template: ['test'],
    ...overrides,
  };
}

export function validParameterizedCommand(overrides = {}) {
  return validCommand({
    command_id: 'file-tests',
    argv_template: ['test', '--', '{file}'],
    parameters: {
      file: { type: 'path_segment', max_bytes: 64 },
    },
    ...overrides,
  });
}

export function validPolicy(overrides = {}) {
  return {
    schema: 'codex-co-engineer.verification-policy.v1',
    version: 1,
    commands: [validCommand()],
    ...overrides,
  };
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

export function trapTotal(counts) {
  return counts.get + counts.ownKeys + counts.getOwnPropertyDescriptor + counts.has + counts.apply;
}
