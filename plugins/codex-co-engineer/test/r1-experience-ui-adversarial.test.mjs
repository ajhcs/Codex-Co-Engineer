// UI-01 adversarial coverage: missing/forged capabilities, malformed URIs,
// owner-only evidence, injection, unexpected states, sixth-tool attempts,
// legacy headless parity, and no action controls or model-visible effects.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INLINE_EXPERIENCE_UI_URIS,
  MCP_RESOURCE_NOT_FOUND,
  clientAdvertisesCompatibleAppsUi,
  experienceUiResourceRegistryForInlineCards,
  experienceUiResourcesForClient,
  readInlineExperienceUiResource,
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

async function withServer(callback) {
  const state = await mkdtemp(path.join(tmpdir(), 'cce-ui01-adv-'));
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
      card: 'run',
      clientCapabilities: capabilities,
      resources: experienceUiResourcesForClient(capabilities),
    }), null, label);
  }
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: appsOnly },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: INLINE_EXPERIENCE_UI_URIS.run } },
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
    { jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: uris.unknown_attention } },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: uris.unknown_sixth } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: uris.spaces } },
  ]);
  for (const response of values.slice(1)) {
    assert.equal(response.error.code, MCP_RESOURCE_NOT_FOUND);
    assert.equal(response.result, undefined);
  }
});

test('owner-only evidence and secrets never enter painted HTML', async () => {
  const hostileReceipt = await loadJson(RESPONSE_DIR, 'hostile-evidence.json');
  const projected = projectExperience(hostileReceipt);
  const projectedHtml = ui.renderRunCardHtml(projected);
  const projectedText = ui.visiblePlainText(projectedHtml);
  const raw = await loadJson(FIXTURE_DIR, 'hostile-card-payload.json');
  const rawHtml = ui.renderRunCardHtml(raw);
  const rawText = ui.visiblePlainText(rawHtml);
  for (const text of [projectedText, rawText, projectedHtml, rawHtml]) {
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
  assert.equal(ui.markupWithoutScripts(rawHtml).toLowerCase().includes('<' + 'script'), false);
  assert.equal(Object.hasOwn(ui.stripOwnerOnly(raw), 'secret'), false);
  assert.equal(Object.hasOwn(ui.stripOwnerOnly(raw.run.lanes[0]), 'prompt'), false);
  assert.equal(projected.run.repository.base_sha, null);
  assert.equal(ui.fieldMap('run', raw).base_sha, ui.NOT_AVAILABLE);
  assert.equal(rawText.includes(HOSTILE_PATH), false);
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

test('sixth-tool attempts and display-only sessions never emit model-visible effects', async () => {
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
  const session = ui.createDisplayOnlySession({ card: 'run' });
  session.start();
  session.handleMessage({
    jsonrpc: '2.0',
    method: ui.TOOL_CALL_METHOD,
    params: { name: 'delegate', arguments: { run: {} } },
  });
  session.handleMessage({ jsonrpc: '2.0', method: 'tools/list' });
  session.handleMessage({ jsonrpc: '2.0', method: 'cancel', params: { cleanup: true } });
  session.handleMessage({ jsonrpc: '2.0', method: 'task', params: { wait_until: 'decision_or_attention' } });
  assert.equal(session.outbound.some((message) => ui.isForbiddenHostMethod(message?.method)), false);
  assert.equal(session.outbound.every((message) => (
    message.method == null || String(message.method).startsWith('ui/')
  )), true);
  assert.equal([...session.rejected].includes(ui.TOOL_CALL_METHOD), true);
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

test('display-only HTML refuses merge push rebase PR tag and release controls', () => {
  const run = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.run).text;
  const finalCard = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.final).text;
  for (const html of [run, finalCard]) {
    assert.equal(ui.documentContainsActionControls(html), false);
    const markup = ui.markupWithoutScripts(html);
    assert.equal(/<button\b/iu.test(markup), false);
    assert.equal(/<form\b/iu.test(markup), false);
    assert.equal(/<input\b/iu.test(markup), false);
    assert.equal(/role\s*=\s*["']button["']/iu.test(markup), false);
    assert.match(markup, /cannot merge, push, rebase, create a pull request, tag, or release/u);
  }
  assert.equal(ui.isForbiddenHostMethod('tools/' + 'call'), true);
  assert.equal(ui.isForbiddenHostMethod('ui/initialize'), false);
});
