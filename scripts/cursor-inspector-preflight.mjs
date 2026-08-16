#!/usr/bin/env node

import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { CursorCloudService, runStdio } from '../plugins/cursor-cloud-control/mcp/server.mjs';

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
assert.equal(responses[2].result.structuredContent.ok, true);
assert.equal(responses[2].result.structuredContent.status.credentials.configured, false);
process.stdout.write(`cursor MCP preflight passed (${tools.length} tools, no network)\n`);
