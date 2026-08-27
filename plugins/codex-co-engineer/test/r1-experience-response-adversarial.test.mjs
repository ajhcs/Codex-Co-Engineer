// UX-04 adversarial coverage: forged evidence, truncation, mixed lanes,
// unsupported replies, missing Apps capability, five-tool freeze, legacy
// bytes, and zero extra model-visible calls.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPERIENCE_DENIED_CONTROLS,
  EXPERIENCE_MAX_BYTES,
  EXPERIENCE_PHRASES,
  EXPERIENCE_UI_RESOURCE_URIS,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_MIME_TYPE,
  PUBLIC_MCP_TOOLS,
  advertiseMcpAppsCapability,
  buildToolResult,
  clientSupportsMcpApps,
  createExperienceUiResourceRegistry,
  listExperienceUiResourcesForClient,
  projectExperience,
  readExperienceUiResourceForClient,
  resolveExperienceResultMeta,
  resolveExperienceToolMeta,
  sanitizeToolPayload,
} from '../mcp/v3/response.mjs';
import {
  classifyRunToolCall,
} from '../mcp/v3/run-tool-adapter.mjs';
import {
  HOSTILE_SECRET,
  createAdapter,
  makeAssignment,
  makeAttentionItem,
  makeRunArgs,
  makeVerifier,
} from './fixtures/r1-run-tool-adapter-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'v3-experience-response');
const UX01 = path.join(HERE, 'fixtures', 'v3-experience-contract.json');

async function loadJson(name) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), 'utf8'));
}

function serialized(value) {
  return JSON.stringify(value);
}

test('unknown and forged evidence never enter model or UI projections', async () => {
  const hostile = await loadJson('hostile-evidence.json');
  const projection = projectExperience(hostile);
  const text = serialized(projection);
  assert.equal(text.includes(HOSTILE_SECRET), false);
  assert.equal(text.includes('github_pat_hostileleak'), false);
  assert.equal(text.includes('github_pat_hostile'), false);
  assert.equal(text.includes('/tmp/hostile-repo'), false);
  assert.equal(text.includes('RAW_OWNER_ONLY'), false);
  assert.equal(text.includes('SECRETBYTES'), false);
  assert.equal(text.includes('forged_kind'), false);
  assert.equal(text.includes('forged_fact'), false);
  assert.equal(Object.hasOwn(projection, 'raw'), false);
  assert.equal(projection.run.repository.base_sha, null);
  assert.equal(Object.hasOwn(projection.run.repository, 'repository_path'), false);
  assert.equal(projection.run.lanes[0].raw, undefined);
  assert.equal(projection.card, 'run');
  const envelope = buildToolResult({ mode: 'run', experience: projection });
  const envelopeText = serialized(envelope);
  assert.equal(envelopeText.includes(HOSTILE_SECRET), false);
  assert.equal(envelopeText.includes('github_pat_hostile'), false);
});

test('truncation and redaction bound the projection and strip secrets', async () => {
  const receipt = await loadJson('run-receipt.json');
  receipt.objective = `sk-live-ATTACKER-SECRET ${'x'.repeat(4000)}`;
  receipt.lanes[0].write_scope = [`${'src/'.repeat(80)}file.js`];
  const projection = projectExperience(receipt);
  assert.ok(projection.run.objective.length < receipt.objective.length);
  assert.match(projection.run.objective, /\[REDACTED\]/u);
  assert.equal(projection.run.objective.includes(HOSTILE_SECRET), false);
  assert.ok(Buffer.byteLength(serialized(projection), 'utf8') <= EXPERIENCE_MAX_BYTES);
  assert.ok(projection.run.lanes[0].scope[0].endsWith('…') || projection.run.lanes[0].scope[0].length <= 96);
});

test('mixed lane states keep unaffected work running and bucket a final mix', async () => {
  const attention = await loadJson('attention-receipt.json');
  const grouped = projectExperience(attention);
  assert.equal(grouped.card, 'attention');
  assert.deepEqual(grouped.attention.unaffected_lanes, ['docs']);
  assert.equal(grouped.attention.affected_lanes.includes('validator'), true);
  assert.equal(grouped.attention.questions.length, 2);

  const mixedFinal = await loadJson('final-receipt.json');
  const final = projectExperience(mixedFinal);
  assert.equal(final.card, 'final');
  assert.deepEqual(final.final.accepted_lanes, ['validator']);
  assert.deepEqual(final.final.failed_lanes, ['docs']);
  assert.deepEqual(final.final.unresolved_lanes, ['review']);
  assert.equal(final.summary.verified_final, null);
});

test('unsupported same-session reply marks the lane unresolved and does not invent a reply', async () => {
  const { adapter } = createAdapter();
  const assignments = [
    makeAssignment({ assignmentId: 'writer', taskId: 'task-writer', writeScope: ['src/**'] }),
    makeAssignment({
      assignmentId: 'dsh-lane',
      taskId: 'task-dsh',
      provider: 'dsh',
      model: 'muse-spark-1.2-contributor',
      writeScope: ['docs/**'],
    }),
  ];
  await adapter.dispatch('delegate', makeRunArgs({ assignments }));
  const latched = await adapter.dispatch('task', {
    run_id: makeRunArgs().run.run_id,
    attention: {
      items: [
        makeAttentionItem({
          assignmentId: 'dsh-lane',
          taskId: 'task-dsh',
          provider: 'dsh',
          sessionId: 'sess-dsh',
          questionId: 'q-dsh',
          prompt: 'DSH cannot host a same-session reply',
        }),
      ],
    },
  });
  assert.equal(latched.experience.card, 'attention');
  assert.equal(latched.experience.attention.unsupported.unresolved, true);
  assert.equal(latched.experience.attention.unsupported.lanes.includes('dsh-lane'), true);
  assert.equal(latched.experience.attention.reply.run_reply.reply.answers.length, 0);
  const dshQuestion = latched.experience.attention.questions.find((item) => item.assignment_id === 'dsh-lane');
  assert.equal(dshQuestion.reply_capability, 'unsupported');
  assert.equal(dshQuestion.disposition, 'unresolved');
});

test('missing Apps capability never advertises ui:// metadata or resources', () => {
  const registry = createExperienceUiResourceRegistry([{
    uri: EXPERIENCE_UI_RESOURCE_URIS.shell,
    mimeType: MCP_APPS_MIME_TYPE,
    text: '<html></html>',
  }]);
  for (const tool of PUBLIC_MCP_TOOLS) {
    assert.equal(resolveExperienceToolMeta(tool, {
      clientCapabilities: null,
      resources: registry,
    }), null);
  }
  assert.equal(clientSupportsMcpApps({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html'] } } }), false);
  assert.equal(advertiseMcpAppsCapability({
    clientCapabilities: { extensions: {} },
    resources: registry,
  }), null);
  assert.equal(listExperienceUiResourcesForClient({
    clientCapabilities: {},
    resources: registry,
  }), null);
  assert.equal(readExperienceUiResourceForClient(EXPERIENCE_UI_RESOURCE_URIS.shell, {
    clientCapabilities: {},
    resources: registry,
  }), null);
  assert.equal(resolveExperienceResultMeta({
    card: 'final',
    clientCapabilities: { tools: { listChanged: false } },
    resources: registry,
  }), null);
  const forgedMime = createExperienceUiResourceRegistry();
  assert.equal(forgedMime.register({
    uri: EXPERIENCE_UI_RESOURCE_URIS.shell,
    mimeType: 'text/html',
    text: '<html></html>',
  }), false);
  const apps = {
    extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] } },
  };
  assert.equal(resolveExperienceToolMeta('task', {
    clientCapabilities: apps,
    resources: forgedMime,
  }), null);
  const wrapped = buildToolResult({ ok: true }, {
    uiMeta: { [MCP_APPS_LEGACY_RESOURCE_URI_META_KEY]: EXPERIENCE_UI_RESOURCE_URIS.shell },
  });
  assert.equal(Object.hasOwn(wrapped, '_meta'), false);
});

test('catalog stays exactly five public tools with no extra model-visible calls', async () => {
  const ux01 = JSON.parse(await readFile(UX01, 'utf8'));
  assert.deepEqual([...PUBLIC_MCP_TOOLS], ['status', 'delegate', 'task', 'tasks', 'cancel']);
  assert.deepEqual(PUBLIC_MCP_TOOLS, ux01.tools);
  for (const name of ['run', 'supervise', 'experience', 'reply', 'resources']) {
    assert.equal(PUBLIC_MCP_TOOLS.includes(name), false, name);
    assert.equal(classifyRunToolCall(name, { run_id: 'auth-split' }).mode, 'run');
  }
  const { adapter } = createAdapter();
  const before = { ...adapter.counters };
  await adapter.dispatch('delegate', makeRunArgs({
    assignments: [
      makeAssignment(),
      makeVerifier('review'),
    ],
  }));
  assert.equal(adapter.counters.submit, before.submit + 1);
  assert.equal(adapter.counters.inspect, before.inspect);
  const afterSubmit = { ...adapter.counters };
  const inspected = await adapter.dispatch('status', { run_id: makeRunArgs().run.run_id });
  assert.equal(adapter.counters.inspect, afterSubmit.inspect + 1);
  assert.equal(adapter.counters.submit, afterSubmit.submit);
  assert.equal(inspected.experience.coordination.submissions, 1);
  const afterInspect = { ...adapter.counters };
  assert.equal(inspected.experience.schema.startsWith('codex-co-engineer.experience'), true);
  assert.equal(adapter.counters.inspect, afterInspect.inspect);
  assert.equal(adapter.counters.resume, afterInspect.resume);
  assert.equal(adapter.counters.reply, 0);
});

test('legacy omitted-mode bytes stay a duplicate of structuredContent without experience', async () => {
  const payload = await loadJson('legacy-status.json');
  const first = buildToolResult(payload);
  const second = buildToolResult(payload);
  assert.equal(first.content[0].text, second.content[0].text);
  assert.equal(first.content[0].text, JSON.stringify(first.structuredContent));
  assert.deepEqual(first.structuredContent, sanitizeToolPayload(payload));
  assert.equal(Object.hasOwn(first, '_meta'), false);
  assert.equal(Object.hasOwn(first.structuredContent, 'experience'), false);
  assert.equal(first.content[0].text.includes('"card":"run"'), false);
  const controls = serialized(EXPERIENCE_DENIED_CONTROLS);
  assert.match(controls, /"merge":false/u);
});

test('human summaries stay free of internal jargon while authority fields remain', async () => {
  const ux01 = JSON.parse(await readFile(UX01, 'utf8'));
  for (const name of ['run-receipt.json', 'attention-receipt.json', 'final-receipt.json']) {
    const projection = projectExperience(await loadJson(name));
    const spoken = `${projection.summary.phrases.join(' ')} ${projection.summary.delegating ?? ''} ${
      projection.summary.attention ?? ''
    } ${projection.summary.verified_final ?? ''}`;
    for (const term of ux01.forbidden_user_terms) {
      assert.equal(spoken.includes(term), false, `${name} leaked ${term}`);
    }
    assert.equal(spoken.includes('P33'), false);
    assert.equal(spoken.includes('P34'), false);
    assert.equal(projection.authority.truth, 'r-truth');
    assert.equal(projection.authority.lifecycle, 'p33');
  }
  const verified = projectExperience(await loadJson('final-receipt.json'));
  assert.equal(verified.summary.phrases.includes(EXPERIENCE_PHRASES.verified_final), false);
});
