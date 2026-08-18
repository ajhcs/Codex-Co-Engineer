#!/usr/bin/env node

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { CursorCloudService, runStdio } from '../plugins/cursor-cloud-control/mcp/server.mjs';
import { CursorLocalService, runStdio as runLocalStdio } from '../plugins/cursor-cloud-control/mcp/local.mjs';

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } },
];

const output = [];
const outputStream = new Writable({ write(chunk, _encoding, callback) { output.push(chunk.toString()); callback(); } });
const env = {
  ...process.env,
  CURSOR_API_KEY: '',
  CURSOR_API_KEY_FILE: `/tmp/cursor-cloud-control-preflight-missing-key-${process.pid}`,
  CURSOR_CLOUD_CONTROL_STATE_DIR: `/tmp/cursor-cloud-control-preflight-${process.pid}`,
};
await runStdio({
  input: Readable.from(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`),
  output: outputStream,
  service: new CursorCloudService({ env }),
});
const responses = output.join('').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(responses[0].result.serverInfo.name, 'cursor-cloud-control');
assert.equal(responses[0].result.protocolVersion, '2025-11-25');
const tools = responses[1].result.tools.map((tool) => tool.name);
assert.deepEqual(tools, ['status', 'agents', 'runs', 'artifacts', 'usage', 'lifecycle']);
const agentsTool = responses[1].result.tools.find((tool) => tool.name === 'agents');
const statusTool = responses[1].result.tools.find((tool) => tool.name === 'status');
assert.ok(agentsTool);
assert.ok(statusTool);
const repositorySchema = agentsTool.inputSchema.properties.repos;
assert.equal(repositorySchema.type, 'array');
assert.ok(repositorySchema.minItems === undefined || repositorySchema.minItems === 0);
assert.equal(repositorySchema.maxItems, 20);
assert.equal(repositorySchema.items.type, 'object');
assert.deepEqual(repositorySchema.items.required, ['url']);
assert.equal(repositorySchema.items.additionalProperties, false);
assert.equal(repositorySchema.items.properties.url.type, 'string');
assert.equal(repositorySchema.items.properties.url.format, 'uri');
assert.equal(repositorySchema.items.properties.url.maxLength, 2048);
assert.equal(repositorySchema.items.properties.startingRef.type, 'string');
assert.equal(repositorySchema.items.properties.startingRef.minLength, 1);
assert.equal(repositorySchema.items.properties.startingRef.maxLength, 200);
assert.equal(repositorySchema.items.properties.startingRef.pattern, undefined);
assert.equal(repositorySchema.items.properties.prUrl.type, 'string');
assert.equal(repositorySchema.items.properties.prUrl.format, 'uri');
assert.equal(repositorySchema.items.properties.prUrl.maxLength, 2048);
const mcpServerSchema = agentsTool.inputSchema.properties.mcpServers.items;
const authEnvSchema = mcpServerSchema.properties.authEnv;
assert.deepEqual(authEnvSchema.required, ['CLIENT_ID']);
assert.equal(authEnvSchema.additionalProperties, false);
assert.deepEqual(authEnvSchema.properties.CLIENT_ID, {
  type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$',
});
assert.deepEqual(authEnvSchema.properties.scopes, {
  type: 'array', minItems: 1, maxItems: 50,
  items: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$' },
});
assert.equal(mcpServerSchema.properties.headerEnv.type, 'object');
assert.equal(mcpServerSchema.properties.headerEnv.maxProperties, 50);
assert.deepEqual(mcpServerSchema.properties.headerEnv.patternProperties, {
  "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$": {
    type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z_][A-Za-z0-9_]{0,254}$',
  },
});
const agentIdPattern = '^bc-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
assert.deepEqual(agentsTool.inputSchema.properties.agentId, { type: 'string', pattern: agentIdPattern });
for (const branch of agentsTool.inputSchema.oneOf) {
  if (branch.properties.agentId !== undefined) assert.equal(branch.properties.agentId.pattern, agentIdPattern);
}
const envValueSchema = agentsTool.inputSchema.properties.envVars.patternProperties['^[A-Za-z_][A-Za-z0-9_]{0,254}$'];
assert.deepEqual(envValueSchema, { type: 'string', minLength: 1, maxLength: 4096 });
const imageSchema = agentsTool.inputSchema.properties.prompt.properties.images.items;
assert.deepEqual(imageSchema.properties.dimension, {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  },
  required: ['width', 'height'],
  additionalProperties: false,
});
const dataImageVariant = imageSchema.oneOf.find((variant) => variant.required.includes('data'));
const urlImageVariant = imageSchema.oneOf.find((variant) => variant.required.length === 1 && variant.required[0] === 'url');
assert.deepEqual(dataImageVariant.not, { required: ['url'] });
assert.deepEqual(urlImageVariant.not, { anyOf: [{ required: ['data'] }, { required: ['mimeType'] }] });
const subagentSchema = agentsTool.inputSchema.properties.customSubagents.items;
assert.equal(agentsTool.inputSchema.properties.customSubagents.maxItems, 20);
assert.deepEqual(subagentSchema.properties.description, { type: 'string', minLength: 1, maxLength: 1000 });
assert.deepEqual(subagentSchema.properties.prompt, { type: 'string', minLength: 1, maxLength: 8192 });
assert.deepEqual(subagentSchema.not, {
  properties: { name: { enum: ['explore', 'shell', 'debug', 'computerUse', 'cursorGuide'] } },
});
const statusBranches = statusTool.inputSchema.oneOf;
const statusBranch = (action) => statusBranches.find((branch) => branch.properties.action.const === action);
assert.equal(statusBranch('local').properties.limit, undefined);
assert.equal(statusBranch('identity').properties.limit, undefined);
assert.deepEqual(statusBranch('models').properties.limit, { type: 'integer', minimum: 1, maximum: 100 });
assert.deepEqual(statusBranch('models').properties.detail, { type: 'boolean' });
assert.deepEqual(statusBranch('models').properties.refresh, { type: 'boolean' });
assert.equal(statusBranch('repositories').properties.detail, undefined);
assert.equal(statusBranch('repositories').properties.refresh, undefined);
assert.deepEqual(statusBranch('repositories').properties.limit, { type: 'integer', minimum: 1, maximum: 100 });
assert.equal(responses[2].result.structuredContent.ok, true);
assert.equal(responses[2].result.structuredContent.status.credentials.configured, false);
process.stdout.write(`cursor MCP preflight passed (${tools.length} tools, no network)\n`);

const localRequests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { action: 'local' } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run', arguments: {} } },
];
const localOutput = [];
const localOutputStream = new Writable({ write(chunk, _encoding, callback) { localOutput.push(chunk.toString()); callback(); } });
const localEnv = {
  ...process.env,
  HOME: '/tmp/cursor-local-control-preflight-home',
  CURSOR_LOCAL_CLI_BIN: `/tmp/cursor-local-control-preflight-missing-${process.pid}`,
  CURSOR_LOCAL_CONTROL_STATE_DIR: `/tmp/cursor-local-control-preflight-state-${process.pid}`,
};
await runLocalStdio({
  input: Readable.from(`${localRequests.map((request) => JSON.stringify(request)).join('\n')}\n`),
  output: localOutputStream,
  service: new CursorLocalService({ env: localEnv }),
});
const localResponses = localOutput.join('').trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(localResponses[0].result.serverInfo.name, 'cursor-local-control');
assert.deepEqual(localResponses[1].result.tools.map((tool) => tool.name), ['status']);
assert.equal(localResponses[2].result.structuredContent.ok, true);
assert.equal(localResponses[2].result.structuredContent.status.safety.runEnabled, false);
assert.equal(localResponses[3].result.isError, true);
assert.equal(localResponses[3].result.structuredContent.error.code, 'foundation_not_exposed');
process.stdout.write('cursor local MCP preflight passed (status-only catalog, provider-free)\n');
