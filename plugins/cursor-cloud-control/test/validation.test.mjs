import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InputError,
  TOOL_SCHEMAS,
  assertSafeArtifactPath,
  assertSafeRelativeDestination,
  validateToolInput,
} from '../mcp/validation.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

test('create requires a stable request ID, usage permits an omitted run ID, and actions reject foreign fields', () => {
  assert.throws(
    () => validateToolInput('agents', { action: 'create', prompt: { text: 'plan this' } }),
    /requestId is required/,
  );
  const create = validateToolInput('agents', { action: 'create', requestId: 'create-plan-1', prompt: { text: 'plan this' } });
  assert.equal(create.action, 'create');
  assert.throws(
    () => validateToolInput('runs', { action: 'followup', agentId, prompt: { text: 'continue' } }),
    /requestId is required/,
  );
  assert.equal(validateToolInput('usage', { agentId }).runId, undefined);
  assert.throws(() => validateToolInput('agents', { action: 'list', prompt: { text: 'not allowed' } }), InputError);
  assert.throws(() => validateToolInput('runs', { action: 'get', agentId, runId, timeoutMs: 1000 }), InputError);
  assert.throws(() => validateToolInput('status', { action: 'identity', fullIdentity: true }), /not supported/);
});

test('agent reconciliation requires only a stable request ID and accepts an optional opaque provider ID', () => {
  assert.deepEqual(validateToolInput('agents', {
    action: 'reconcile', requestId: 'reconcile-validation-1',
  }), {
    action: 'reconcile', requestId: 'reconcile-validation-1',
  });
  assert.equal(validateToolInput('agents', {
    action: 'reconcile', requestId: 'reconcile-validation-2', agentId,
  }).agentId, agentId);
  assert.throws(() => validateToolInput('agents', {
    action: 'reconcile', requestId: 'reconcile-validation-3', prompt: { text: 'not accepted' },
  }), /not supported/);
});

test('run and lifecycle reconciliation expose typed release confirmations and cancellation request IDs', () => {
  assert.deepEqual(validateToolInput('runs', { action: 'cancel', requestId: 'cancel-validation-1', agentId, runId }), {
    action: 'cancel', requestId: 'cancel-validation-1', agentId, runId,
  });
  assert.deepEqual(validateToolInput('runs', {
    action: 'reconcile', requestId: 'run-reconcile-validation-1', release: true, confirmation: 'release:run-reconcile-validation-1',
  }), {
    action: 'reconcile', requestId: 'run-reconcile-validation-1', release: true, confirmation: 'release:run-reconcile-validation-1',
  });
  assert.deepEqual(validateToolInput('lifecycle', {
    action: 'reconcile', requestId: 'life-reconcile-validation-1', agentId,
  }), { action: 'reconcile', requestId: 'life-reconcile-validation-1', agentId });
  assert.throws(() => validateToolInput('lifecycle', {
    action: 'reconcile', requestId: 'life-reconcile-validation-2', release: true,
  }), /confirmation is required/);
});

test('write-mode repository dispatch requires an immutable start commit', () => {
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-1', mode: 'agent', prompt: { text: 'implement' },
    repos: [{ url: 'https://github.com/acme/project', startingRef: 'main' }],
  }), /immutable/);
  const value = validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-2', mode: 'agent', prompt: { text: 'implement' },
    repos: [{ url: 'https://github.com/acme/project', startingRef: '0123456789012345678901234567890123456789' }],
  });
  assert.equal(value.mode, 'agent');
  const customModel = validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-3', prompt: { text: 'delegate' },
    customSubagents: [{ name: 'review', description: 'Review changes', prompt: 'Review the patch', model: 'composer-2' }],
  });
  assert.equal(customModel.customSubagents[0].model, 'composer-2');
});

test('Cursor v1 create bounds match the typed image, repository, and caller ID contract', () => {
  const base = {
    action: 'create',
    requestId: 'image-contract-1',
    prompt: {
      text: 'inspect the image',
      images: [{ data: 'abcd', mimeType: 'image/png', dimension: { width: 1, height: 2 } }],
    },
    repos: [],
    agentId,
  };
  assert.deepEqual(validateToolInput('agents', base).repos, []);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    agentId: 'bc-not-a-uuid',
  }), /invalid format/);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    prompt: { text: 'inspect the image', images: [{ url: 'https://example.test/image.png', mimeType: 'image/png' }] },
  }), /must be omitted/);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    prompt: { text: 'inspect the image', images: [{ data: 'abcd', mimeType: 'image/png', dimension: { width: 1 } }] },
  }), /height is required/);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    agentId: undefined,
    envVars: { EMPTY_VALUE: '' },
  }), /1-4096/);
  assert.equal(TOOL_SCHEMAS.agents.properties.repos.minItems, undefined);

  const urlImage = {
    ...base,
    prompt: {
      text: 'inspect the image URL',
      images: [{ url: 'https://example.test/image.png', dimension: { width: 320, height: 240 } }],
    },
  };
  assert.deepEqual(validateToolInput('agents', urlImage).prompt.images, urlImage.prompt.images);

  for (const invalidId of [
    'bc-00000000-0000-0000-0000-00000000000',
    'bc-00000000-0000-0000-0000-00000000000z',
    'bc-0000000000000000000000000000000000000001',
  ]) {
    assert.throws(() => validateToolInput('agents', { ...base, agentId: invalidId }), /invalid format/);
  }
});

test('Cursor v1 custom subagents enforce documented limits and built-in names', () => {
  const create = {
    action: 'create',
    requestId: 'subagent-contract-1',
    prompt: { text: 'delegate' },
    customSubagents: [{
      name: 'reviewer',
      description: 'd'.repeat(1000),
      prompt: 'p'.repeat(8192),
    }],
  };
  assert.equal(validateToolInput('agents', create).customSubagents[0].prompt.length, 8192);
  assert.throws(() => validateToolInput('agents', {
    ...create,
    customSubagents: [{ ...create.customSubagents[0], description: 'd'.repeat(1001) }],
  }), /1-1000/);
  assert.throws(() => validateToolInput('agents', {
    ...create,
    customSubagents: [{ ...create.customSubagents[0], prompt: 'p'.repeat(8193) }],
  }), /1-8192/);
  for (const name of ['explore', 'shell', 'debug', 'computerUse', 'cursorGuide']) {
    assert.throws(() => validateToolInput('agents', {
      ...create,
      customSubagents: [{ ...create.customSubagents[0], name }],
    }), /reserved/);
  }
  assert.throws(() => validateToolInput('agents', {
    ...create,
    customSubagents: [
      { ...create.customSubagents[0], name: 'reviewer-a' },
      { ...create.customSubagents[0], name: 'reviewer-a' },
    ],
  }), /reserved or duplicated/);
  const maxSubagents = Array.from({ length: 20 }, (_, index) => ({
    ...create.customSubagents[0],
    name: `reviewer-${index}`,
  }));
  assert.equal(validateToolInput('agents', { ...create, customSubagents: maxSubagents }).customSubagents.length, 20);
  assert.throws(() => validateToolInput('agents', {
    ...create,
    customSubagents: [...maxSubagents, { ...create.customSubagents[0], name: 'reviewer-overflow' }],
  }), /at most 20/);
  const subagentSchema = TOOL_SCHEMAS.agents.properties.customSubagents.items;
  assert.deepEqual(subagentSchema.not.properties.name.enum, ['explore', 'shell', 'debug', 'computerUse', 'cursorGuide']);
  assert.equal(subagentSchema.properties.description.maxLength, 1000);
  assert.equal(subagentSchema.properties.prompt.maxLength, 8192);
});

test('status limit is a local cap only for model and repository discovery', () => {
  assert.equal(validateToolInput('status', { action: 'models', limit: 3 }).limit, 3);
  assert.equal(validateToolInput('status', { action: 'models', detail: true, refresh: true }).detail, true);
  assert.equal(validateToolInput('status', { action: 'repositories', limit: 3 }).limit, 3);
  assert.throws(() => validateToolInput('status', { action: 'local', limit: 3 }), /not supported/);
  assert.throws(() => validateToolInput('status', { action: 'identity', limit: 3 }), /not supported/);
  assert.throws(() => validateToolInput('status', { action: 'repositories', refresh: true }), /not supported/);
  assert.throws(() => validateToolInput('status', { action: 'identity', detail: true }), /not supported/);
});

test('sensitive MCP headers and unsafe destinations are rejected', () => {
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'create-agent-4', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer hidden-value' } }],
  }), /credential-bearing/);
  assert.throws(() => assertSafeArtifactPath('artifacts/../secret.txt'), /unsafe/);
  assert.throws(() => assertSafeRelativeDestination('../outside.txt'), /unsafe/);
  assert.equal(assertSafeArtifactPath('artifacts/log.txt'), 'artifacts/log.txt');
});

test('remote MCP secret references are typed, non-overlapping, and never accepted for stdio', () => {
  const value = validateToolInput('agents', {
    action: 'create', requestId: 'mcp-secret-refs-1', prompt: { text: 'use a server' },
    mcpServers: [{
      name: 'remote', type: 'http', url: 'https://example.test/mcp',
      authEnv: { CLIENT_ID: 'MCP_CLIENT_ID', CLIENT_SECRET: 'MCP_CLIENT_SECRET', scopes: ['MCP_SCOPE_READ'] },
      headerEnv: { Authorization: 'MCP_AUTHORIZATION' },
    }],
  });
  assert.equal(value.mcpServers[0].authEnv.CLIENT_ID, 'MCP_CLIENT_ID');
  assert.deepEqual(TOOL_SCHEMAS.agents.properties.mcpServers.items.properties.authEnv, {
    type: 'object',
    properties: {
      CLIENT_ID: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$' },
      CLIENT_SECRET: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$' },
      scopes: {
        type: 'array', minItems: 1, maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$' },
      },
    },
    required: ['CLIENT_ID'],
    additionalProperties: false,
  });
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'mcp-secret-refs-2', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'local', type: 'stdio', command: 'node', authEnv: { CLIENT_ID: 'MCP_CLIENT_ID' } }],
  }), /not valid for a stdio/);
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'mcp-secret-refs-3', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', headerEnv: { 'X-Trace': 'MCP_TOKEN' }, headers: { 'x-trace': 'literal' } }],
  }), /conflicts with a literal header/);
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'mcp-secret-refs-4', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', authEnv: { CLIENT_ID: 'MCP_TOKEN', CLIENT_SECRET: 'MCP_TOKEN' } }],
  }), /duplicates another secret environment reference/);
  assert.throws(() => validateToolInput('agents', {
    action: 'create', requestId: 'mcp-secret-refs-5', prompt: { text: 'use a server' },
    mcpServers: [{ name: 'remote', type: 'http', url: 'https://example.test/mcp', authEnv: { CLIENT_ID: 'CURSOR_API_KEY' } }],
  }), /reserved/);
});

test('delete confirmation is tied exactly to the target ID', () => {
  assert.throws(() => validateToolInput('lifecycle', { action: 'delete', agentId, confirmation: agentId }), /exactly/);
  const value = validateToolInput('lifecycle', { action: 'delete', agentId, confirmation: `delete:${agentId}` });
  assert.equal(value.confirmation, `delete:${agentId}`);
  assert.equal(validateToolInput('runs', { action: 'get', agentId, runId }).runId, runId);
});
