// Shared fixtures for the W15-P16B approved-command resolver tests.
// Pure data and tiny local helpers; no I/O and no product imports beyond
// the P16A policy fixtures.

import {
  countingProxy,
  trapTotal,
  validCommand,
  validParameterizedCommand,
  validPolicy,
} from './r1-verification-policy-fixtures.mjs';

export {
  countingProxy,
  trapTotal,
  validCommand,
  validParameterizedCommand,
  validPolicy,
};

export function validTypedCommand(overrides = {}) {
  return validCommand({
    command_id: 'typed-run',
    argv_template: [
      'run', '--file', '{file}', '--count', '{count}', '--ok', '{ok}',
      '--mode', '{mode}', '--note', '{note}',
    ],
    parameters: {
      count: { type: 'integer', min: 0, max: 8 },
      file: { type: 'path_segment', max_bytes: 64 },
      mode: { type: 'enum', values: ['ci', 'local'] },
      note: { type: 'string', max_bytes: 32 },
      ok: { type: 'boolean' },
    },
    ...overrides,
  });
}

export function validTypedParameters(overrides = {}) {
  return {
    count: 2,
    file: 'spec.js',
    mode: 'ci',
    note: 'unit',
    ok: true,
    ...overrides,
  };
}

export function validSelection(overrides = {}) {
  return {
    command_id: 'unit-tests',
    ...overrides,
  };
}

export function validRequest(overrides = {}) {
  return {
    policy: validPolicy(),
    selection: validSelection(),
    ...overrides,
  };
}

export function parameterizedRequest(overrides = {}) {
  return {
    policy: validPolicy({ commands: [validParameterizedCommand()] }),
    selection: {
      command_id: 'file-tests',
      parameters: { file: 'spec.js' },
    },
    ...overrides,
  };
}

export function typedRequest(overrides = {}) {
  return {
    policy: validPolicy({ commands: [validTypedCommand()] }),
    selection: {
      command_id: 'typed-run',
      parameters: validTypedParameters(),
    },
    ...overrides,
  };
}
