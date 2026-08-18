import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CursorCloudService, handleToolCall } from '../mcp/server.mjs';
import { SubmissionLedger } from '../mcp/ledger.mjs';
import {
  RESERVED_SUBAGENT_NAMES,
  TOOL_SCHEMAS,
  validateToolInput,
} from '../mcp/validation.mjs';

const agentId = 'bc-00000000-0000-0000-0000-000000000001';
const runId = 'run-00000000-0000-0000-0000-000000000001';

class EchoClient {
  constructor() {
    this.calls = [];
  }

  async createAgent(body) {
    this.calls.push(['createAgent', body]);
    // Echo the submitted configuration so this test verifies both the
    // provider payload and the model-facing redaction boundary.
    return {
      agent: { id: body.agentId ?? agentId, submitted: body },
      run: { id: runId, agentId: body.agentId ?? agentId, submitted: body },
    };
  }
}

async function fixture(context) {
  const state = await mkdtemp(path.join(os.tmpdir(), 'cursor-custom-subagents-'));
  context.after(() => rm(state, { recursive: true, force: true }));
  const client = new EchoClient();
  const service = new CursorCloudService({
    env: { HOME: state, CURSOR_API_AUTH_SCHEME: 'bearer' },
    client,
    ledger: new SubmissionLedger({ stateDir: state }),
  });
  return { client, service, state };
}

function customSubagents(promptA = 'CUSTOM_SUBAGENT_PROMPT__REVIEW', promptB = 'CUSTOM_SUBAGENT_PROMPT__ARCHITECT') {
  return [
    {
      name: 'reviewer',
      description: 'Review the proposed change for correctness.',
      prompt: promptA,
      model: 'inherit',
    },
    {
      name: 'architect',
      description: 'Check the design and identify integration risks.',
      prompt: promptB,
      model: { id: 'composer-2', params: [{ id: 'temperature', value: '0.2' }] },
    },
  ];
}

test('custom subagents map exactly while receipts and durable state stay compact', async (context) => {
  const { client, service, state } = await fixture(context);
  const mainPrompt = 'MAIN_PROMPT__IMPLEMENT_WITH_REVIEW';
  const definitions = customSubagents();
  const args = {
    action: 'create',
    requestId: 'custom-subagent-map-1',
    prompt: { text: mainPrompt },
    model: { id: 'grok-code', params: [{ id: 'reasoningEffort', value: 'high' }] },
    customSubagents: definitions,
  };

  const result = await handleToolCall('agents', args, service);
  assert.equal(result.structuredContent.ok, true);
  const createCall = client.calls.find(([operation]) => operation === 'createAgent');
  assert.ok(createCall, 'createAgent should be called once');
  assert.deepEqual(createCall[1].customSubagents, definitions);
  assert.deepEqual(createCall[1].prompt, args.prompt);
  assert.deepEqual(createCall[1].model, args.model);

  const receipt = result.structuredContent.receipt;
  assert.equal(receipt.effectiveConfiguration.customSubagentCount, definitions.length);
  assert.match(receipt.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(receipt, 'prompt'), false);
  assert.equal(Object.hasOwn(receipt, 'customSubagents'), false);
  assert.equal(Object.hasOwn(receipt.effectiveConfiguration, 'customSubagents'), false);
  assert.equal(Object.hasOwn(receipt.effectiveConfiguration, 'prompt'), true);
  assert.equal(receipt.effectiveConfiguration.prompt.textChars, mainPrompt.length);

  const serializedResult = JSON.stringify(result);
  for (const secretPrompt of [mainPrompt, ...definitions.map((entry) => entry.prompt)]) {
    assert.equal(serializedResult.includes(secretPrompt), false, `result leaked ${secretPrompt}`);
  }
  const ledger = await readFile(path.join(state, 'submissions.json'), 'utf8');
  for (const secretPrompt of [mainPrompt, ...definitions.map((entry) => entry.prompt)]) {
    assert.equal(ledger.includes(secretPrompt), false, `ledger leaked ${secretPrompt}`);
  }

  const duplicate = await handleToolCall('agents', args, service);
  assert.equal(duplicate.structuredContent.receipt.duplicate, true);
  assert.equal(duplicate.structuredContent.receipt.requestDigest, receipt.requestDigest);
  assert.equal(client.calls.filter(([operation]) => operation === 'createAgent').length, 1);

  const changed = await handleToolCall('agents', {
    ...args,
    customSubagents: customSubagents('CUSTOM_SUBAGENT_PROMPT__CHANGED', definitions[1].prompt),
  }, service);
  assert.equal(changed.isError, true);
  assert.equal(changed.structuredContent.error.code, 'request_id_conflict');
  assert.equal(client.calls.filter(([operation]) => operation === 'createAgent').length, 1);
});

test('custom subagent validation covers model references, boundaries, reserved names, and uniqueness', () => {
  const base = {
    action: 'create',
    requestId: 'custom-subagent-bounds-1',
    prompt: { text: 'delegate' },
    customSubagents: [{
      name: 'reviewer',
      description: 'd'.repeat(1000),
      prompt: 'p'.repeat(8192),
      model: 'inherit',
    }],
  };
  const accepted = validateToolInput('agents', base);
  assert.equal(accepted.customSubagents[0].prompt.length, 8192);
  assert.equal(accepted.customSubagents[0].description.length, 1000);

  const objectModel = validateToolInput('agents', {
    ...base,
    customSubagents: [{ ...base.customSubagents[0], model: { id: 'composer-2' } }],
  });
  assert.deepEqual(objectModel.customSubagents[0].model, { id: 'composer-2' });
  assert.throws(() => validateToolInput('agents', {
    ...base,
    customSubagents: [{ ...base.customSubagents[0], model: { id: '' } }],
  }), /1-200/);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    customSubagents: [{ ...base.customSubagents[0], prompt: 'p'.repeat(8193) }],
  }), /1-8192/);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    customSubagents: [{ ...base.customSubagents[0], description: 'd'.repeat(1001) }],
  }), /1-1000/);

  for (const name of RESERVED_SUBAGENT_NAMES) {
    assert.throws(() => validateToolInput('agents', {
      ...base,
      customSubagents: [{ ...base.customSubagents[0], name }],
    }), /reserved/);
  }
  assert.throws(() => validateToolInput('agents', {
    ...base,
    customSubagents: [base.customSubagents[0], { ...base.customSubagents[0], name: 'reviewer' }],
  }), /reserved or duplicated/);
  const twenty = Array.from({ length: 20 }, (_, index) => ({
    ...base.customSubagents[0],
    name: `reviewer-${index}`,
  }));
  assert.equal(validateToolInput('agents', { ...base, customSubagents: twenty }).customSubagents.length, 20);
  assert.throws(() => validateToolInput('agents', {
    ...base,
    customSubagents: [...twenty, { ...base.customSubagents[0], name: 'reviewer-overflow' }],
  }), /at most 20/);

  const schema = TOOL_SCHEMAS.agents.properties.customSubagents;
  assert.equal(schema.maxItems, 20);
  assert.deepEqual(schema.items.not.properties.name.enum, [...RESERVED_SUBAGENT_NAMES]);
  assert.deepEqual(schema.items.properties.model.anyOf.map((entry) => entry.type ?? 'object'), ['string', 'object']);
});

test('custom subagents are create-time configuration; Cursor streams expose only the parent run', () => {
  assert.equal(Object.hasOwn(TOOL_SCHEMAS.runs.properties, 'customSubagents'), false);
  const followupSchema = TOOL_SCHEMAS.runs.oneOf.find((entry) => entry.properties.action?.const === 'followup');
  const streamSchema = TOOL_SCHEMAS.runs.oneOf.find((entry) => entry.properties.action?.const === 'stream');
  assert.equal(Object.hasOwn(followupSchema.properties, 'customSubagents'), false);
  assert.equal(Object.hasOwn(streamSchema.properties, 'customSubagents'), false);

  assert.throws(() => validateToolInput('runs', {
    action: 'followup',
    requestId: 'custom-subagent-followup-1',
    agentId,
    prompt: { text: 'continue' },
    customSubagents: customSubagents(),
  }), /customSubagents is not supported/);
  assert.throws(() => validateToolInput('runs', {
    action: 'stream',
    agentId,
    runId,
    customSubagents: customSubagents(),
  }), /customSubagents is not supported/);
});
