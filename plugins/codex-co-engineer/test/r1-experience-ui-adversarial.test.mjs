// UI-02 adversarial coverage: grouped cardinality, keyboard/focus, reduced
// motion, contrast/theme/RTL/safe areas, secret/injection stripping, stale
// cursor/revision, cross-run/cross-batch authority, double-submit, reconnect
// replay, unsupported provider reply, and forbidden actions/model calls.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DISPLAY_ONLY_EXPERIENCE_UI_CARDS,
  INLINE_EXPERIENCE_UI_URIS,
  MCP_RESOURCE_NOT_FOUND,
  clientAdvertisesCompatibleAppsUi,
  experienceUiResourceRegistryForInlineCards,
  experienceUiResourcesForClient,
  readInlineExperienceUiResource,
  CodexCoEngineerAttentionUi as attentionUi,
  CodexCoEngineerExperienceUi as ui,
} from '../mcp/v3/experience-ui-resource.mjs';
import {
  EXPERIENCE_PHRASES,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  MCP_APPS_MIME_TYPE,
  PUBLIC_MCP_TOOLS,
  advertiseMcpAppsCapability,
  buildToolResult,
  listExperienceUiResourcesForClient,
  projectExperience,
  readExperienceUiResourceForClient,
  resolveExperienceResultMeta,
  sanitizeToolPayload,
} from '../mcp/v3/response.mjs';
import { classifyRunToolCall as classifyAdapter } from '../mcp/v3/run-tool-adapter.mjs';
import { HOSTILE_PATH, HOSTILE_SECRET } from './fixtures/r1-run-runtime-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(HERE, '..');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'v3-experience-ui');
const RESPONSE_DIR = path.join(HERE, 'fixtures', 'v3-experience-response');
const SERVER = path.join(PLUGIN, 'mcp', 'v3', 'server.mjs');

async function loadJson(dir, name) {
  return JSON.parse(await readFile(path.join(dir, name), 'utf8'));
}

function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16) / 255,
    g: Number.parseInt(value.slice(2, 4), 16) / 255,
    b: Number.parseInt(value.slice(4, 6), 16) / 255,
  };
}

function channel(value) {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(foreground, background) {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  const lighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (lighter + 0.05) / (darker + 0.05);
}

async function withServer(callback) {
  const state = await mkdtemp(path.join(tmpdir(), 'cce-ui02-adv-'));
  const child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: {
      ...process.env,
      CODEX_CO_ENGINEER_STATE_DIR: state,
      CODEX_CO_ENGINEER_GROK_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_CURSOR_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_ACPX_COMMAND: '/bin/false',
      CODEX_CO_ENGINEER_DSH_ACP_COMMAND: 'false',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const nextValue = () => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  });
  lines.on('line', (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(JSON.parse(line));
  });
  child.once('error', (error) => {
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`MCP server exited (${code ?? signal}): ${stderr}`);
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  const request = async (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return nextValue();
  };
  try {
    return await callback({ request });
  } finally {
    child.stdin.end();
    child.kill('SIGTERM');
    lines.close();
    await rm(state, { recursive: true, force: true });
  }
}

async function conversation(messages) {
  return withServer(async ({ request }) => {
    const values = [];
    for (const message of messages) values.push(await request(message));
    return values;
  });
}

async function attentionProjection() {
  return projectExperience(await loadJson(RESPONSE_DIR, 'attention-receipt.json'));
}

function toolCalls(session) {
  return session.outbound.filter((message) => message.method === attentionUi.TOOL_CALL_METHOD);
}

test('missing and forged Apps or resource capabilities stay silent', async () => {
  const forged = await loadJson(FIXTURE_DIR, 'forged-capabilities.json');
  const appsOnly = await loadJson(FIXTURE_DIR, 'apps-only-client.json');
  assert.equal(clientAdvertisesCompatibleAppsUi({}), false);
  assert.equal(clientAdvertisesCompatibleAppsUi(null), false);
  assert.equal(clientAdvertisesCompatibleAppsUi(appsOnly.capabilities), false);
  for (const [label, capabilities] of Object.entries(forged)) {
    assert.equal(clientAdvertisesCompatibleAppsUi(capabilities), false, label);
    assert.equal(experienceUiResourcesForClient(capabilities).list().length, 0, label);
    assert.equal(advertiseMcpAppsCapability({
      clientCapabilities: capabilities,
      resources: experienceUiResourcesForClient(capabilities),
    }), null, label);
    assert.equal(listExperienceUiResourcesForClient({
      clientCapabilities: capabilities,
      resources: experienceUiResourcesForClient(capabilities),
    }), null, label);
    assert.equal(resolveExperienceResultMeta({
      card: 'attention',
      clientCapabilities: capabilities,
      resources: experienceUiResourcesForClient(capabilities),
    }), null, label);
  }
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: appsOnly },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: INLINE_EXPERIENCE_UI_URIS.attention } },
  ]);
  assert.deepEqual(values[0].result.capabilities, { tools: { listChanged: false } });
  assert.equal(values[1].result.tools.length, 5);
  for (const tool of values[1].result.tools) assert.equal(Object.hasOwn(tool, '_meta'), false);
  assert.equal(values[2].error.code, -32601);
  assert.equal(values[3].error.code, -32601);
});

test('malformed and unknown resource URIs never register and do not crash', async () => {
  const uris = await loadJson(FIXTURE_DIR, 'malformed-uris.json');
  const capabilities = (await loadJson(FIXTURE_DIR, 'compatible-client.json')).capabilities;
  const resources = experienceUiResourcesForClient(capabilities);
  for (const [label, uri] of Object.entries(uris)) {
    assert.equal(readInlineExperienceUiResource(uri), null, label);
    assert.equal(readExperienceUiResourceForClient(uri, {
      clientCapabilities: capabilities,
      resources,
    }), null, label);
  }
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: await loadJson(FIXTURE_DIR, 'compatible-client.json') },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: uris.file } },
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: uris.unknown_attention_forged } },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: uris.unknown_sixth } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: uris.spaces } },
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: uris.unknown_shell } },
  ]);
  for (const response of values.slice(1)) {
    assert.equal(response.error.code, MCP_RESOURCE_NOT_FOUND);
    assert.equal(response.result, undefined);
  }
});

test('owner-only evidence, secrets, and injection never enter painted HTML', async () => {
  attentionUi.resetSubmittedForTests();
  const hostileReceipt = await loadJson(RESPONSE_DIR, 'hostile-evidence.json');
  const projected = projectExperience(hostileReceipt);
  const projectedHtml = ui.renderRunCardHtml(projected);
  const raw = await loadJson(FIXTURE_DIR, 'hostile-card-payload.json');
  const rawHtml = ui.renderRunCardHtml(raw);
  const hostileAttention = await loadJson(FIXTURE_DIR, 'hostile-attention-payload.json');
  const attentionHtml = attentionUi.renderAttentionCardHtml(hostileAttention);
  const attentionText = attentionUi.visiblePlainText(attentionHtml);
  for (const text of [
    ui.visiblePlainText(projectedHtml),
    ui.visiblePlainText(rawHtml),
    projectedHtml,
    rawHtml,
    attentionHtml,
    attentionText,
  ]) {
    assert.equal(text.includes(HOSTILE_SECRET), false);
    assert.equal(text.includes('github_pat_hostileleak'), false);
    assert.equal(text.includes('github_pat_hostile'), false);
    assert.equal(text.includes('RAW_OWNER_ONLY'), false);
    assert.equal(text.includes('OWNER_ONLY_PROMPT'), false);
    assert.equal(text.includes('SECRETBYTES'), false);
    assert.equal(text.includes('hidden owner prompt'), false);
  }
  assert.equal(rawHtml.includes('<' + 'script>alert(1)</' + 'script>'), false);
  assert.equal(rawHtml.includes('&lt;script&gt;'), true);
  assert.equal(attentionHtml.includes('<' + 'script>alert(1)</' + 'script>'), false);
  assert.equal(attentionHtml.includes('&lt;script&gt;'), true);
  assert.equal(Object.hasOwn(ui.stripOwnerOnly(raw), 'secret'), false);
  assert.equal(Object.hasOwn(attentionUi.bindAttention(hostileAttention).answerable[0] ?? {}, 'prompt'), false);
  assert.equal(projected.run.repository.base_sha, null);
  assert.equal(ui.fieldMap('run', raw).base_sha, ui.NOT_AVAILABLE);
  assert.equal(ui.visiblePlainText(rawHtml).includes(HOSTILE_PATH), false);
});

test('grouped cardinality stays one group of at most eight unique questions', async () => {
  attentionUi.resetSubmittedForTests();
  const hostile = await loadJson(FIXTURE_DIR, 'hostile-attention-payload.json');
  const grouped = attentionUi.groupQuestions(hostile.attention);
  assert.equal(grouped.length, 2);
  assert.equal(grouped.filter((question) => question.assignment_id === 'validator').length, 1);
  const overflow = structuredClone(hostile);
  overflow.attention.questions = Array.from({ length: 12 }, (_, index) => ({
    assignment_id: `lane-${index}`,
    question_id: `q-${index}`,
    session_id: `sess-${index}`,
    task_id: `task-${index}`,
    question: `Question ${index}`,
    options: ['yes'],
    event_cursor: '12',
    reply_capability: 'same_session',
    disposition: 'pending',
  }));
  overflow.attention.reply.run_reply.reply.answers = overflow.attention.questions.slice(0, 8).map((question) => ({
    assignment_id: question.assignment_id,
    question_id: question.question_id,
    session_id: question.session_id,
    task_id: question.task_id,
    response: null,
  }));
  overflow.attention.affected_lanes = overflow.attention.questions.map((question) => question.assignment_id);
  overflow.attention.unsupported = { lanes: [], unresolved: false, code: null };
  const bound = attentionUi.bindAttention(overflow);
  assert.equal(bound.questions.length, 8);
  assert.equal(bound.answerable.length, 8);
  const html = attentionUi.renderAttentionCardHtml(overflow);
  assert.equal((html.match(/<fieldset>/g) || []).length, 8);
  assert.equal(html.includes('Question 8'), false);
});

test('keyboard focus order and live region stay deterministic', async () => {
  attentionUi.resetSubmittedForTests();
  const projection = await attentionProjection();
  const bound = attentionUi.bindAttention(projection);
  const html = attentionUi.renderAttentionCardHtml(projection);
  const resource = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.attention).text;
  assert.match(html, /role="status"/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(resource, /:focus-visible/u);
  assert.match(html, /<label for="cce-answer-validator-stricter">/u);
  assert.match(html, /id="cce-attention-submit"/u);
  assert.deepEqual([...attentionUi.tabOrder(bound)], [
    'cce-answer-validator-stricter',
    'cce-answer-validator-keep',
    'cce-attention-submit',
  ]);
  assert.equal(attentionUi.focusPlan(bound, 'ready').target, 'cce-answer-validator-stricter');
  const session = attentionUi.createAttentionSession();
  session.paint(projection);
  assert.equal(session.focused.at(-1).target, 'cce-answer-validator-stricter');
  session.submit({ validator: 'stricter' });
  assert.equal(session.focusPlan().target, 'cce-attention-status');
  assert.equal(session.focused.at(-1).reason, 'submitted');
});

test('contrast, theme, RTL, and safe-area contracts are present without color-only meaning', async () => {
  const css = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.attention).text;
  assert.match(css, /prefers-color-scheme: dark/u);
  assert.match(css, /data-cce-theme="dark"/u);
  assert.match(css, /data-cce-theme="light"/u);
  assert.match(css, /safe-area-inset-top/u);
  assert.match(css, /safe-area-inset-inline|safe-area-inset-left/u);
  assert.match(css, /padding-inline/u);
  assert.match(css, /dir="ltr"/u);
  assert.equal(contrastRatio('#111111', '#FFFFFF') >= 4.5, true);
  assert.equal(contrastRatio('#374151', '#FFFFFF') >= 4.5, true);
  assert.equal(contrastRatio('#4B5563', '#FFFFFF') >= 4.5, true);
  assert.equal(contrastRatio('#6B7280', '#FFFFFF') >= 4.5, true);
  assert.equal(contrastRatio('#F9FAFB', '#111111') >= 4.5, true);
  assert.equal(contrastRatio('#D1D5DB', '#111111') >= 4.5, true);
  const projection = await attentionProjection();
  const html = attentionUi.renderAttentionCardHtml(projection);
  const text = attentionUi.visiblePlainText(html);
  assert.equal(text.includes('Affected assignments'), true);
  assert.equal(text.includes('Unaffected assignments'), true);
  assert.equal(text.includes('Unresolved assignments'), true);
  assert.equal(text.includes('These assignments keep working.'), true);
  const documentRef = {
    documentElement: {
      attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
    },
  };
  ui.applyHostContext(documentRef, { theme: 'dark', locale: 'ar-SA', dir: 'rtl' });
  assert.equal(documentRef.documentElement.attrs['data-cce-theme'], 'dark');
  assert.equal(documentRef.documentElement.attrs.lang, 'ar-SA');
  assert.equal(documentRef.documentElement.attrs.dir, 'rtl');
});

test('reduced motion stops decorative animation and only allows one truthful state change', () => {
  const css = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.attention).text;
  assert.match(css, /prefers-reduced-motion: reduce/u);
  assert.match(css, /animation: none !important/u);
  assert.match(css, /cce-truthful-state/u);
  assert.match(css, /ease-out 1 both/u);
  assert.equal(/animation:[^;]*infinite/i.test(css), false);
  assert.equal(css.includes('progress'), false);
  assert.equal(css.includes('spinner'), false);
  assert.equal(css.includes('background-image'), false);
});

test('stale cursor, revision, and missing identities fail closed', async () => {
  attentionUi.resetSubmittedForTests();
  const projection = await attentionProjection();
  const bound = attentionUi.bindAttention(projection);
  const reply = attentionUi.buildGroupedReply(bound, { validator: 'stricter' });
  assert.equal(attentionUi.authorizeReply(bound, reply, { validator: 'stricter' }).ok, true);
  const staleCursor = { ...bound, event_cursor: '1' };
  assert.equal(attentionUi.missingAuthority(staleCursor), 'cursor_mismatch');
  const missingCursor = { ...bound, event_cursor: null };
  assert.equal(attentionUi.missingAuthority(missingCursor), 'cursor_missing');
  const staleRevision = attentionUi.authorizeReply(bound, {
    ...reply,
    expected_revision: 9,
  }, { validator: 'stricter' });
  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.code, 'revision_mismatch');
  const missingBatch = attentionUi.missingAuthority({ ...bound, batch_id: null });
  assert.equal(missingBatch, 'batch_missing');
  const missingRun = attentionUi.missingAuthority({ ...bound, run_id: null });
  assert.equal(missingRun, 'run_missing');
  const missingQuestion = attentionUi.missingAuthority({
    ...bound,
    answerable: [{ ...bound.answerable[0], question_id: null }],
  });
  assert.equal(missingQuestion, 'question_mismatch');
});

test('cross-run and cross-batch replies are rejected', async () => {
  attentionUi.resetSubmittedForTests();
  const projection = await attentionProjection();
  const bound = attentionUi.bindAttention(projection);
  const reply = attentionUi.buildGroupedReply(bound, { validator: 'stricter' });
  const otherBatch = attentionUi.authorizeReply(bound, {
    ...reply,
    batch_id: 'att-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    reply: { ...reply.reply, batch_id: 'att-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  }, { validator: 'stricter' });
  assert.equal(otherBatch.ok, false);
  assert.equal(otherBatch.code, 'batch_mismatch');
  const session = attentionUi.createAttentionSession();
  session.paint(projection);
  const forged = {
    jsonrpc: '2.0',
    id: 'cce-attention-reply',
    method: attentionUi.TOOL_CALL_METHOD,
    params: {
      name: 'task',
      arguments: {
        run_id: 'other-run',
        run_reply: reply,
      },
    },
  };
  assert.equal(attentionUi.isPermittedReplyCall(forged, bound), false);
  session.handleMessage(forged);
  assert.equal(toolCalls(session).length, 0);
  assert.equal(session.rejected.includes(attentionUi.TOOL_CALL_METHOD), true);
});

test('double submit and reconnect replay send only one tools/call', async () => {
  attentionUi.resetSubmittedForTests();
  const projection = await attentionProjection();
  const replayStore = attentionUi.createReplayStore();
  const session = attentionUi.createAttentionSession({ replayStore });
  session.start();
  session.paint(projection);
  const first = session.submit({ validator: 'stricter' });
  const second = session.submit({ validator: 'keep' });
  session.handleMessage({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: { structuredContent: { experience: projection } },
  });
  const third = session.submit({ validator: 'keep' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already_submitted');
  assert.equal(third.ok, false);
  assert.equal(toolCalls(session).length, 1);
  const replay = attentionUi.createAttentionSession({ replayStore });
  replay.start();
  replay.paint(projection);
  const replayed = replay.submit({ validator: 'stricter' });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.code, 'already_submitted');
  assert.equal(toolCalls(replay).length, 0);
});

test('unsupported provider replies stay visible unresolved lanes and are not answered', async () => {
  attentionUi.resetSubmittedForTests();
  const projection = await attentionProjection();
  const bound = attentionUi.bindAttention(projection);
  assert.deepEqual([...bound.unresolved_lanes], ['cloud-review']);
  assert.equal(bound.unsupported.unresolved, true);
  assert.equal(bound.unsupported.code, 'same_session_reply_unsupported');
  const html = attentionUi.renderAttentionCardHtml(projection);
  const text = attentionUi.visiblePlainText(html);
  assert.equal(text.includes('cloud-review'), true);
  assert.equal(text.includes('cannot take a same-session reply'), true);
  assert.equal(text.includes('do not start another run'), true);
  const withUnsupported = attentionUi.buildGroupedReply(bound, {
    validator: 'stricter',
    'cloud-review': 'approve',
  });
  assert.equal(withUnsupported.reply.answers.some((answer) => answer.assignment_id === 'cloud-review'), false);
  const rejected = attentionUi.authorizeReply(bound, withUnsupported, {
    validator: 'stricter',
    'cloud-review': 'approve',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'lane_mismatch');
  const unaffected = attentionUi.authorizeReply(bound, attentionUi.buildGroupedReply(bound, {
    validator: 'stricter',
    docs: 'keep going',
  }), { validator: 'stricter', docs: 'keep going' });
  assert.equal(unaffected.ok, false);
  assert.equal(unaffected.code, 'lane_mismatch');
});

test('injection and unexpected states stay display-only and never verify a gap', async () => {
  const unexpected = await loadJson(FIXTURE_DIR, 'unexpected-final.json');
  const html = ui.renderFinalCardHtml(unexpected);
  const text = ui.visiblePlainText(html);
  assert.equal(ui.documentContainsActionControls(html), false);
  assert.equal(text.includes(EXPERIENCE_PHRASES.verified_final), false);
  assert.equal(text.includes('p35'), false);
  assert.equal(text.includes('P33'), false);
  assert.equal(text.includes('R-TRUTH'), false);
  assert.equal(text.includes('AttentionBatch'), false);
  assert.equal(text.includes('forged_kind'), false);
  assert.equal(text.includes('../etc/passwd'), false);
  assert.equal(ui.fieldMap('final', unexpected).head, ui.NOT_AVAILABLE);
  assert.equal(ui.fieldMap('final', unexpected).tree, ui.NOT_AVAILABLE);
  assert.equal(ui.fieldMap('final', unexpected).verified_final, '');
  assert.equal(html.includes('<button'), false);
  assert.equal(html.includes('create_pr'), false);
  const session = ui.createDisplayOnlySession({ card: 'final' });
  session.paint(unexpected);
  assert.equal([...session.painted].join(','), 'final');
  assert.equal(session.outbound.some((message) => ui.isForbiddenHostMethod(message?.method)), false);
});

test('sixth-tool attempts and forbidden host methods never emit extra model-visible effects', async () => {
  attentionUi.resetSubmittedForTests();
  assert.deepEqual([...PUBLIC_MCP_TOOLS], ['status', 'delegate', 'task', 'tasks', 'cancel']);
  for (const name of ['experience', 'supervise', 'ui', 'resources', 'reply']) {
    assert.equal(PUBLIC_MCP_TOOLS.includes(name), false, name);
    assert.equal(classifyAdapter(name, { run_id: 'auth-split' }).mode, 'run');
  }
  const registry = experienceUiResourceRegistryForInlineCards();
  assert.equal(registry.register({
    uri: 'ui://codex-co-engineer/experience/supervise',
    mimeType: MCP_APPS_MIME_TYPE,
    text: '<html></html>',
  }), false);
  const display = ui.createDisplayOnlySession({ card: 'run' });
  display.start();
  display.handleMessage({
    jsonrpc: '2.0',
    method: ui.TOOL_CALL_METHOD,
    params: { name: 'delegate', arguments: { run: {} } },
  });
  display.handleMessage({ jsonrpc: '2.0', method: 'tools/list' });
  display.handleMessage({ jsonrpc: '2.0', method: 'cancel', params: { cleanup: true } });
  display.handleMessage({ jsonrpc: '2.0', method: 'task', params: { wait_until: 'decision_or_attention' } });
  assert.equal(display.outbound.some((message) => ui.isForbiddenHostMethod(message?.method)), false);
  assert.equal(display.outbound.every((message) => (
    message.method == null || String(message.method).startsWith('ui/')
  )), true);
  const projection = await attentionProjection();
  const attention = attentionUi.createAttentionSession();
  attention.start();
  attention.paint(projection);
  attention.handleMessage({ jsonrpc: '2.0', method: attentionUi.TOOL_CALL_METHOD, params: { name: 'delegate', arguments: {} } });
  attention.handleMessage({ jsonrpc: '2.0', method: 'task', params: { wait_until: 'decision_or_attention' } });
  attention.handleMessage({ jsonrpc: '2.0', method: 'ui/message', params: { role: 'user', content: { text: 'chat' } } });
  const waitCall = {
    jsonrpc: '2.0',
    id: 'x',
    method: attentionUi.TOOL_CALL_METHOD,
    params: {
      name: 'task',
      arguments: { run_id: projection.run_id, wait_until: 'decision_or_attention' },
    },
  };
  assert.equal(attentionUi.isPermittedReplyCall(waitCall, attentionUi.bindAttention(projection)), false);
  assert.equal(toolCalls(attention).length, 0);
  assert.equal(attention.outbound.every((message) => (
    message.method == null
    || String(message.method).startsWith('ui/')
    || message.method === attentionUi.TOOL_CALL_METHOD
  )), true);
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: await loadJson(FIXTURE_DIR, 'compatible-client.json') },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'experience', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
  ]);
  assert.equal(values[1].result.isError, true);
  assert.equal(
    ['unknown_tool', 'catalog_sixth_tool_denied'].includes(values[1].result.structuredContent.error.code),
    true,
  );
  assert.deepEqual(values[2].result.tools.map((tool) => tool.name), [...PUBLIC_MCP_TOOLS]);
});

test('legacy omitted-mode headless bytes stay 3.2.1 duplicates without UI metadata', async () => {
  const payload = await loadJson(RESPONSE_DIR, 'legacy-status.json');
  const omitted = buildToolResult(payload);
  assert.deepEqual(omitted.structuredContent, sanitizeToolPayload(payload));
  assert.equal(omitted.content[0].text, JSON.stringify(omitted.structuredContent));
  assert.equal(Object.hasOwn(omitted, '_meta'), false);
  assert.equal(Object.hasOwn(omitted.structuredContent, 'experience'), false);
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ]);
  assert.deepEqual(values[0].result.capabilities, { tools: { listChanged: false } });
  assert.equal(values[1].result.tools.length, 5);
  assert.equal(values[2].error.code, -32601);
  assert.equal(Object.hasOwn(values[3].result, '_meta'), false);
  assert.equal(values[3].result.content[0].text, JSON.stringify(values[3].result.structuredContent));
  const wrapped = buildToolResult({ ok: true }, {
    uiMeta: { [MCP_APPS_LEGACY_RESOURCE_URI_META_KEY]: INLINE_EXPERIENCE_UI_URIS.run },
  });
  assert.equal(Object.hasOwn(wrapped, '_meta'), false);
});

test('run and final HTML refuse merge push rebase PR tag and release controls', () => {
  for (const card of DISPLAY_ONLY_EXPERIENCE_UI_CARDS) {
    const html = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS[card]).text;
    assert.equal(ui.documentContainsActionControls(html), false);
    const markup = ui.markupWithoutScripts(html);
    assert.equal(/<button\b/iu.test(markup), false);
    assert.equal(/<form\b/iu.test(markup), false);
    assert.equal(/<input\b/iu.test(markup), false);
    assert.equal(/role\s*=\s*["']button["']/iu.test(markup), false);
    assert.match(markup, /cannot merge, push, rebase, create a pull request, tag, or release/u);
  }
  const attention = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.attention).text;
  assert.equal(attentionUi.attentionDocumentHasForbiddenControls(attention), false);
  assert.match(attention, /cannot merge, push, rebase, create a pull request, tag, or release/u);
  assert.equal(ui.isForbiddenHostMethod('tools/' + 'call'), true);
  assert.equal(ui.isForbiddenHostMethod('ui/initialize'), false);
});
