// UX-04 experience projection: consume UX-01 phrases, project three cards,
// and expose capability-gated MCP Apps metadata without a sixth tool.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXPERIENCE_AUTHORITY,
  EXPERIENCE_CARD_STATES,
  EXPERIENCE_COORDINATION,
  EXPERIENCE_DENIED_CONTROLS,
  EXPERIENCE_PHRASES,
  EXPERIENCE_SCHEMA,
  EXPERIENCE_UI_RESOURCE_URIS,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_MIME_TYPE,
  MCP_APPS_URI_SCHEME,
  PROVIDER_DISPLAY,
  PUBLIC_MCP_TOOLS,
  RESPONSE_MODE_STRUCTURED,
  advertiseMcpAppsCapability,
  buildToolResult,
  classifyExperienceCard,
  clientSupportsMcpApps,
  createExperienceUiResourceRegistry,
  listExperienceUiResourcesForClient,
  projectExperience,
  readExperienceUiResourceForClient,
  resolveExperienceResultMeta,
  resolveExperienceToolMeta,
  preparingPhrase,
  runningPhrase,
  sanitizeToolPayload,
} from '../mcp/v3/response.mjs';
import {
  PUBLIC_MCP_CATALOG,
  classifyRunToolCall,
  createRunToolAdapter,
} from '../mcp/v3/run-tool-adapter.mjs';
import {
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

function appsCapabilities() {
  return {
    extensions: {
      [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] },
    },
  };
}

test('experience projection consumes the UX-01 phrase and tool catalog', async () => {
  const ux01 = JSON.parse(await readFile(UX01, 'utf8'));
  const contract = await loadJson('contract.json');
  assert.deepEqual(PUBLIC_MCP_TOOLS, ux01.tools);
  assert.deepEqual(PUBLIC_MCP_TOOLS, contract.tools);
  assert.deepEqual(PUBLIC_MCP_CATALOG, ux01.tools);
  assert.equal(PUBLIC_MCP_TOOLS.length, 5);
  assert.equal(EXPERIENCE_PHRASES.delegating, ux01.codex_phrases.delegating);
  assert.equal(EXPERIENCE_PHRASES.attention, ux01.codex_phrases.attention);
  assert.equal(EXPERIENCE_PHRASES.verified_final, ux01.codex_phrases.verified_final);
  assert.equal(EXPERIENCE_PHRASES.running_one, ux01.codex_phrases.running_one);
  assert.equal(runningPhrase(1), ux01.codex_phrases.running_one);
  assert.equal(runningPhrase(3), 'Co-Engineer is running 3 independent assignments');
  assert.equal(runningPhrase(9), null);
  assert.deepEqual(PROVIDER_DISPLAY, ux01.provider_display);
  assert.deepEqual(EXPERIENCE_CARD_STATES, contract.cards);
  assert.equal(EXPERIENCE_COORDINATION.aggregate_wait, ux01.coordination.aggregate_wait);
  assert.equal(EXPERIENCE_COORDINATION.submissions, 1);
  assert.equal(EXPERIENCE_COORDINATION.grouped_reply, 1);
});

test('inline run card projects objective, repository SHA, lanes, and Codex authority', async () => {
  const receipt = await loadJson('run-receipt.json');
  const first = projectExperience(receipt);
  const second = projectExperience(receipt);
  assert.deepEqual(first, second);
  assert.equal(first.schema, EXPERIENCE_SCHEMA);
  assert.equal(first.card, 'run');
  assert.equal(classifyExperienceCard(receipt), 'run');
  assert.equal(first.summary.delegating, EXPERIENCE_PHRASES.delegating);
  assert.equal(first.summary.running, 'Co-Engineer is running 2 independent assignments');
  assert.deepEqual(first.summary.phrases, [
    EXPERIENCE_PHRASES.delegating,
    'Using Grok Co-Engineer',
    'Using Muse Co-Engineer',
    'Co-Engineer is running 2 independent assignments',
  ]);
  assert.equal(first.run.objective, receipt.objective);
  assert.equal(first.run.repository.base_sha, receipt.base_sha);
  assert.equal(first.run.repository.digest, receipt.git.digest);
  assert.equal(first.run.lanes.length, 2);
  const validator = first.run.lanes.find((lane) => lane.assignment_id === 'validator');
  assert.equal(validator.provider_phrase, 'Using Grok Co-Engineer');
  assert.deepEqual(validator.scope, ['src/validator/**']);
  assert.equal(validator.state, 'running');
  assert.deepEqual(first.run.authority, EXPERIENCE_AUTHORITY);
  assert.equal(first.authority.truth, 'r-truth');
  assert.equal(first.authority.lifecycle, 'p33');
  assert.equal(first.summary.phrases.join(' ').includes('R-TRUTH'), false);
  assert.equal(first.summary.phrases.join(' ').includes('AttentionBatch'), false);
  assert.equal(Object.hasOwn(first.run.repository, 'repository_path'), false);
});

test('simple run cards say preparing until required prompt evidence is authoritative', () => {
  const receipt = {
    schema: 'codex-co-engineer.run-admission.v1',
    run_id: 'simple-card',
    assignment_count: 2,
    authoritative_required_dispatch: false,
    lanes: [
      { assignment_id: 'one', provider: 'grok', role: 'implement', required: true, phase: 'prepared', prompt_dispatched: false, dispatch_confidence: 'not_sent' },
      { assignment_id: 'two', provider: 'cursor-local', role: 'review', required: true, phase: 'session_ready', prompt_dispatched: false, dispatch_confidence: 'not_sent' },
    ],
  };
  const preparing = projectExperience(receipt);
  assert.equal(preparing.summary.running, preparingPhrase(2));
  assert.equal(preparing.summary.phrases.includes('Co-Engineer is running 2 independent assignments'), false);

  const running = projectExperience({
    ...receipt,
    authoritative_required_dispatch: true,
    lanes: receipt.lanes.map((lane) => ({
      ...lane,
      phase: 'prompt_dispatched',
      prompt_dispatched: true,
      dispatch_confidence: 'authoritative',
    })),
  });
  assert.equal(running.summary.running, 'Co-Engineer is running 2 independent assignments');
});

test('grouped attention card collects questions once, marks lanes, and keeps one structured reply', async () => {
  const receipt = await loadJson('attention-receipt.json');
  const projection = projectExperience(receipt);
  assert.equal(projection.card, 'attention');
  assert.equal(projection.summary.attention, EXPERIENCE_PHRASES.attention);
  assert.equal(projection.summary.verified_final, null);
  assert.equal(projection.attention.questions.length, 2);
  assert.equal(projection.attention.reply.structured, true);
  assert.equal(projection.attention.reply.rounds, 1);
  assert.equal(projection.attention.reply.cursor_resume, true);
  assert.equal(projection.attention.reply.event_cursor, '12');
  assert.deepEqual(projection.attention.affected_lanes, ['cloud-review', 'validator']);
  assert.deepEqual(projection.attention.unaffected_lanes, ['docs']);
  assert.equal(projection.attention.reply.run_reply.reply.round, 1);
  assert.equal(projection.attention.reply.run_reply.reply.answers.length, 1);
  assert.equal(projection.attention.reply.run_reply.reply.answers[0].assignment_id, 'validator');
  assert.equal(projection.attention.unsupported.unresolved, true);
  assert.deepEqual(projection.attention.unsupported.lanes, ['cloud-review']);
  assert.equal(projection.attention.unsupported.code, 'same_session_reply_unsupported');
  const validator = projection.attention.questions.find((item) => item.assignment_id === 'validator');
  const cloud = projection.attention.questions.find((item) => item.assignment_id === 'cloud-review');
  assert.equal(validator.question, 'Use the stricter validator?');
  assert.equal(cloud.question, 'Cloud cannot host a same-session reply');
  assert.equal(cloud.reply_capability, 'unsupported');
  assert.equal(cloud.disposition, 'unresolved');
  assert.equal(cloud.options, null);
  assert.equal(JSON.stringify(projection).includes('prompt'), false);
});

test('final card buckets lanes, git identity, and evidence without merge controls', async () => {
  const receipt = await loadJson('final-receipt.json');
  const projection = projectExperience(receipt);
  assert.equal(projection.card, 'final');
  assert.equal(projection.summary.verified_final, null);
  assert.equal(projection.summary.phrases.includes(EXPERIENCE_PHRASES.verified_final), false);
  assert.deepEqual(projection.final.accepted_lanes, ['validator']);
  assert.deepEqual(projection.final.failed_lanes, ['docs']);
  assert.deepEqual(projection.final.unresolved_lanes, ['review']);
  assert.equal(projection.final.git.branch, 'codex-co-engineer/runs/auth-split/validator');
  assert.equal(projection.final.git.head, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(projection.final.git.tree, 'cccccccccccccccccccccccccccccccccccccccc');
  assert.equal(projection.final.git.base_sha, receipt.base_sha);
  assert.equal(projection.final.reviews.present, true);
  assert.equal(projection.final.candidate.authority, 'p35');
  assert.equal(projection.final.evidence.digest, receipt.evidence.digest);
  assert.deepEqual(projection.final.evidence.kinds, ['git_identity', 'head_sha', 'tests_passed']);
  assert.deepEqual(projection.final.controls, EXPERIENCE_DENIED_CONTROLS);
  assert.equal(projection.final.controls.merge, false);
  assert.equal(projection.final.controls.push, false);
  assert.equal(projection.final.controls.rebase, false);
  assert.equal(projection.final.controls.create_pr, false);
});

test('final card reports failed_pre_prompt lanes as failures', async () => {
  const receipt = await loadJson('final-receipt.json');
  receipt.lanes.push({
    assignment_id: 'startup-failure',
    task_id: 'startup-failure-task',
    provider: 'grok',
    status: 'failed_pre_prompt',
    required: true,
    prompt_dispatched: false,
  });
  receipt.assignment_count = receipt.lanes.length;
  const projection = projectExperience(receipt);
  assert.equal(projection.card, 'final');
  assert.deepEqual(projection.final.failed_lanes, ['docs', 'startup-failure']);
});

test('verified-final sentence is used only for an accepted complete candidate', async () => {
  const receipt = await loadJson('final-receipt.json');
  const lanesOnly = structuredClone(receipt);
  lanesOnly.complete_candidate_blocked = false;
  lanesOnly.lanes = lanesOnly.lanes.map((lane) => ({ ...lane, status: 'completed' }));
  const lanesOnlyProjection = projectExperience(lanesOnly);
  assert.equal(lanesOnlyProjection.card, 'final');
  assert.equal(lanesOnlyProjection.summary.verified_final, null);
  assert.equal(lanesOnlyProjection.summary.phrases.includes(EXPERIENCE_PHRASES.verified_final), false);

  const complete = structuredClone(lanesOnly);
  complete.candidate = {
    ...complete.candidate,
    composed: true,
    ready_for_codex_review: true,
    accepted: true,
    authority: 'p35',
  };
  const projection = projectExperience(complete);
  assert.equal(projection.card, 'final');
  assert.equal(projection.summary.verified_final, EXPERIENCE_PHRASES.verified_final);
  assert.equal(projection.summary.phrases.at(-1), EXPERIENCE_PHRASES.verified_final);
  assert.equal(projection.final.candidate.composed, true);
  assert.equal(projection.final.candidate.ready_for_codex_review, true);
  assert.equal(projection.final.candidate.accepted, true);
});

test('adapter submit/wait/reply stay one submission, one wait, one grouped reply', async () => {
  const { adapter, calls } = createAdapter();
  const assignments = [
    makeAssignment({ assignmentId: 'validator', taskId: 'task-validator', writeScope: ['src/**'] }),
    makeVerifier('review'),
  ];
  const submitted = await adapter.dispatch('delegate', makeRunArgs({
    assignments,
    objective: 'Split the validator and the docs.',
  }));
  assert.equal(submitted.experience.card, 'run');
  assert.equal(submitted.experience.run.objective, 'Split the validator and the docs.');
  assert.equal(typeof submitted.experience.run.repository.base_sha, 'string');
  assert.equal(calls.submit.length, 1);
  const wait = await adapter.dispatch('task', {
    run_id: submitted.run_id,
    wait_until: 'decision_or_attention',
    wait_ms: 0,
  });
  assert.equal(wait.operation, 'wait');
  assert.equal(wait.experience.coordination.aggregate_wait, 'decision_or_attention');
  const inspectBefore = adapter.counters.inspect;
  const resumeBefore = adapter.counters.resume;
  assert.equal(wait.experience.schema, EXPERIENCE_SCHEMA);
  assert.equal(adapter.counters.inspect, inspectBefore);
  assert.equal(adapter.counters.resume, resumeBefore);
  const latched = await adapter.dispatch('task', {
    run_id: submitted.run_id,
    attention: { items: [makeAttentionItem({ assignmentId: 'validator', taskId: 'task-validator' })] },
  });
  assert.equal(latched.experience.card, 'attention');
  assert.equal(latched.experience.attention.questions.length, 1);
  assert.equal(latched.experience.attention.questions[0].question, 'Choose the next writer step');
  assert.equal(latched.experience.attention.reply.rounds, 1);
  const replied = await adapter.dispatch('task', {
    run_id: submitted.run_id,
    run_reply: {
      batch_id: latched.attention.batch_id,
      expected_revision: latched.attention.revision,
      reply: {
        round: 1,
        batch_id: latched.attention.batch_id,
        answers: [{
          assignment_id: 'validator',
          question_id: 'q-1',
          session_id: 'sess-1',
          task_id: 'task-validator',
          response: 'stricter',
        }],
      },
    },
  });
  assert.equal(adapter.counters.reply, 1);
  assert.equal(replied.decision_or_attention.exactly_once_reply, true);
  assert.equal(PUBLIC_MCP_TOOLS.includes('supervise'), false);
  assert.equal(classifyRunToolCall('supervise', {}).mode, 'run');
});

test('omitted response_mode preserves full-text 3.2.1 bytes and shape', async () => {
  const payload = await loadJson('legacy-status.json');
  const expected = sanitizeToolPayload(payload);
  const omitted = buildToolResult(payload);
  const explicit = buildToolResult(payload, {});
  assert.deepEqual(omitted.structuredContent, expected);
  assert.equal(omitted.content[0].text, JSON.stringify(expected));
  assert.equal(omitted.content[0].text, JSON.stringify(omitted.structuredContent));
  assert.equal(explicit.content[0].text, omitted.content[0].text);
  assert.equal(Object.hasOwn(omitted, '_meta'), false);
  assert.equal(Object.hasOwn(omitted.structuredContent, 'experience'), false);
  assert.deepEqual(Object.keys(omitted.structuredContent).sort(), Object.keys(payload).sort());
  const structured = buildToolResult(payload, { responseMode: RESPONSE_MODE_STRUCTURED });
  assert.deepEqual(structured.structuredContent, expected);
  assert.notEqual(structured.content[0].text, JSON.stringify(expected));
});

test('MCP Apps metadata is nested, capability-gated, and silent without a resource', () => {
  const registry = createExperienceUiResourceRegistry();
  const missingCap = resolveExperienceToolMeta('task', {
    clientCapabilities: {},
    resources: registry,
  });
  assert.equal(missingCap, null);
  const appsNoResource = resolveExperienceToolMeta('task', {
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.equal(appsNoResource, null);
  assert.equal(advertiseMcpAppsCapability({
    clientCapabilities: appsCapabilities(),
    resources: registry,
  }), null);
  assert.equal(listExperienceUiResourcesForClient({
    clientCapabilities: appsCapabilities(),
    resources: registry,
  }), null);
  assert.equal(clientSupportsMcpApps({}), false);
  assert.equal(clientSupportsMcpApps(appsCapabilities()), true);

  assert.equal(registry.register({
    uri: EXPERIENCE_UI_RESOURCE_URIS.shell,
    mimeType: MCP_APPS_MIME_TYPE,
    text: '<html></html>',
    name: 'experience',
  }), true);
  const stillNoClient = resolveExperienceToolMeta('task', {
    clientCapabilities: { tools: {} },
    resources: registry,
  });
  assert.equal(stillNoClient, null);
  const live = resolveExperienceToolMeta('delegate', {
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.deepEqual(live, { ui: { resourceUri: EXPERIENCE_UI_RESOURCE_URIS.shell } });
  assert.equal(Object.hasOwn(live, MCP_APPS_LEGACY_RESOURCE_URI_META_KEY), false);
  assert.equal(live.ui.resourceUri.startsWith(MCP_APPS_URI_SCHEME), true);
  const advertised = advertiseMcpAppsCapability({
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.deepEqual(advertised[MCP_APPS_EXTENSION_ID].mimeTypes, [MCP_APPS_MIME_TYPE]);
  const listed = listExperienceUiResourcesForClient({
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].mimeType, MCP_APPS_MIME_TYPE);
  const read = readExperienceUiResourceForClient(EXPERIENCE_UI_RESOURCE_URIS.shell, {
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.equal(read.mimeType, MCP_APPS_MIME_TYPE);
  const resultMeta = resolveExperienceResultMeta({
    card: 'run',
    clientCapabilities: appsCapabilities(),
    resources: registry,
  });
  assert.deepEqual(resultMeta, { ui: { resourceUri: EXPERIENCE_UI_RESOURCE_URIS.shell } });
  const wrapped = buildToolResult({ ok: true }, { uiMeta: live });
  assert.deepEqual(wrapped._meta, live);
  const untouched = buildToolResult({ ok: true });
  assert.equal(Object.hasOwn(untouched, '_meta'), false);
});

test('createRunToolAdapter rejects a sixth injected tool seam', () => {
  assert.throws(
    () => createRunToolAdapter({ runtime: {}, attention: {}, experienceTool: {} }),
    (error) => error.code === 'unknown_key' || error.code === 'injected_dependency_invalid',
  );
});
