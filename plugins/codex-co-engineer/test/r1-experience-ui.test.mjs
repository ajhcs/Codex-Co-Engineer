// UI-02 grouped attention plus accessibility: capability-gated resources,
// UX-04 metadata reuse, preserved UI-01 cards, and complete headless fallback.

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
  INLINE_EXPERIENCE_UI_CARDS,
  INLINE_EXPERIENCE_UI_URIS,
  clientAdvertisesCompatibleAppsUi,
  experienceUiResourceRegistryForInlineCards,
  experienceUiResourcesForClient,
  listInlineExperienceUiResources,
  readInlineExperienceUiResource,
  CodexCoEngineerAttentionUi as attentionUi,
  CodexCoEngineerExperienceUi as ui,
} from '../mcp/v3/experience-ui-resource.mjs';
import {
  EXPERIENCE_PHRASES,
  EXPERIENCE_UI_RESOURCE_URIS,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_MIME_TYPE,
  PUBLIC_MCP_TOOLS,
  advertiseMcpAppsCapability,
  buildToolResult,
  experienceUiResourceRegistry,
  listExperienceUiResourcesForClient,
  projectExperience,
  resolveExperienceResultMeta,
  resolveExperienceToolMeta,
} from '../mcp/v3/response.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PLUGIN = path.join(HERE, '..');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'v3-experience-ui');
const RESPONSE_DIR = path.join(HERE, 'fixtures', 'v3-experience-response');
const SERVER = path.join(PLUGIN, 'mcp', 'v3', 'server.mjs');

async function loadJson(dir, name) {
  return JSON.parse(await readFile(path.join(dir, name), 'utf8'));
}

function compatibleCapabilities() {
  return {
    resources: { listChanged: false },
    extensions: {
      [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] },
    },
  };
}

async function withServer(callback) {
  const state = await mkdtemp(path.join(tmpdir(), 'cce-ui02-'));
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

function runPhraseMarkup(html) {
  const match = String(html).match(/<p class="cce-phrase">([\s\S]*?)<\/p>/u);
  return match ? match[1] : null;
}

function phrasePaintRoot() {
  const phrase = {
    attrs: { 'data-field': 'phrase' },
    textContent: 'Waiting for the run projection.',
    getAttribute(name) { return this.attrs[name]; },
  };
  return {
    phrase,
    querySelector(selector) {
      return selector === '[data-field="phrase"]' ? phrase : null;
    },
  };
}

test('inline registry registers run, attention, and final ui:// resources', async () => {
  attentionUi.resetSubmittedForTests();
  const contract = await loadJson(FIXTURE_DIR, 'contract.json');
  const listed = listInlineExperienceUiResources();
  assert.deepEqual(INLINE_EXPERIENCE_UI_CARDS, contract.cards);
  assert.deepEqual(DISPLAY_ONLY_EXPERIENCE_UI_CARDS, contract.display_only_cards);
  assert.equal(listed.length, 3);
  assert.deepEqual(listed.map((resource) => resource.uri).sort(), [
    INLINE_EXPERIENCE_UI_URIS.attention,
    INLINE_EXPERIENCE_UI_URIS.final,
    INLINE_EXPERIENCE_UI_URIS.run,
  ].sort());
  for (const resource of listed) {
    assert.equal(resource.mimeType, MCP_APPS_MIME_TYPE);
    const read = readInlineExperienceUiResource(resource.uri);
    assert.equal(read.mimeType, MCP_APPS_MIME_TYPE);
    assert.match(read.text, /<!DOCTYPE html>/u);
    assert.match(read.text, /<main>/u);
    assert.match(read.text, /lang="en"/u);
    assert.match(read.text, /dir="ltr"/u);
    assert.match(read.text, /color-scheme/u);
  }
  const run = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.run);
  const finalCard = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.final);
  assert.equal(ui.documentContainsActionControls(run.text), false);
  assert.equal(ui.documentContainsActionControls(finalCard.text), false);
  assert.equal(readInlineExperienceUiResource(EXPERIENCE_UI_RESOURCE_URIS.shell), null);
  const registry = experienceUiResourceRegistryForInlineCards();
  assert.equal(registry.register({
    uri: EXPERIENCE_UI_RESOURCE_URIS.shell,
    mimeType: MCP_APPS_MIME_TYPE,
    text: '<html></html>',
  }), false);
  assert.equal(experienceUiResourceRegistry().list().length, 0);
});

test('compatible Apps plus resources clients receive nested metadata for all three cards', () => {
  const capabilities = compatibleCapabilities();
  assert.equal(clientAdvertisesCompatibleAppsUi(capabilities), true);
  const resources = experienceUiResourcesForClient(capabilities);
  const advertised = advertiseMcpAppsCapability({ clientCapabilities: capabilities, resources });
  assert.deepEqual(advertised[MCP_APPS_EXTENSION_ID].mimeTypes, [MCP_APPS_MIME_TYPE]);
  const listed = listExperienceUiResourcesForClient({ clientCapabilities: capabilities, resources });
  assert.equal(listed.length, 3);
  const runMeta = resolveExperienceResultMeta({
    card: 'run',
    clientCapabilities: capabilities,
    resources,
  });
  const attentionMeta = resolveExperienceResultMeta({
    card: 'attention',
    clientCapabilities: capabilities,
    resources,
  });
  const finalMeta = resolveExperienceResultMeta({
    card: 'final',
    clientCapabilities: capabilities,
    resources,
  });
  assert.deepEqual(runMeta, { ui: { resourceUri: INLINE_EXPERIENCE_UI_URIS.run } });
  assert.deepEqual(attentionMeta, { ui: { resourceUri: INLINE_EXPERIENCE_UI_URIS.attention } });
  assert.deepEqual(finalMeta, { ui: { resourceUri: INLINE_EXPERIENCE_UI_URIS.final } });
  assert.equal(resolveExperienceToolMeta('delegate', {
    clientCapabilities: capabilities,
    resources,
  }), null);
  const wrapped = buildToolResult({ mode: 'run', experience: { card: 'attention' } }, { uiMeta: attentionMeta });
  assert.deepEqual(wrapped._meta, attentionMeta);
  assert.equal(Object.hasOwn(wrapped._meta, 'ui/resourceUri'), false);
});

test('run card HTML shows objective, repository SHA, lanes, and Codex authority', async () => {
  const receipt = await loadJson(RESPONSE_DIR, 'run-receipt.json');
  const projection = projectExperience(receipt);
  const html = ui.renderRunCardHtml(projection);
  const text = ui.visiblePlainText(html);
  assert.match(html, /<main>/u);
  assert.match(html, /<article\b/u);
  assert.match(html, /<h1 id="cce-run-title">Co-Engineer run<\/h1>/u);
  assert.match(html, /<h2 id="cce-objective-heading">Objective<\/h2>/u);
  assert.equal(text.includes(receipt.objective), true);
  assert.equal(text.includes(receipt.base_sha), true);
  assert.equal(text.includes(receipt.git.digest), true);
  assert.equal(text.includes('Using Grok Co-Engineer'), true);
  assert.equal(text.includes('Using Muse Co-Engineer'), true);
  assert.equal(text.includes('src/validator/**'), true);
  assert.equal(text.includes('running'), true);
  assert.equal(
    text.includes('I am delegating this to Co-Engineer. Co-Engineer is running 2 independent assignments'),
    true,
  );
  assert.equal(text.includes('I am delegating this to Co-Engineer Co-Engineer is running'), false);
  assert.equal(text.includes(ui.CODEX_AUTHORITY_SENTENCE), true);
  assert.equal(ui.documentContainsActionControls(html), false);
  const resource = readInlineExperienceUiResource(INLINE_EXPERIENCE_UI_URIS.run);
  assert.match(resource.text, /font-family: var\(--cce-font\)/u);
  assert.match(resource.text, /ui-sans-serif, system-ui, Helvetica, Arial, sans-serif/u);
  assert.match(resource.text, /#111111/u);
  assert.match(resource.text, /#374151/u);
  assert.match(resource.text, /prefers-reduced-motion/u);
  assert.equal(resource.text.includes('infinite'), false);
  assert.equal(ui.documentContainsActionControls(resource.text), false);
  assert.equal(ui.markupWithoutScripts(resource.text).toLowerCase().includes('<' + 'button'), false);
});

test('run card joins canonical delegating and running with one sentence boundary', async () => {
  const receipt = await loadJson(RESPONSE_DIR, 'run-receipt.json');
  const projection = projectExperience(receipt);
  const joined = 'I am delegating this to Co-Engineer. Co-Engineer is running 2 independent assignments';
  const html = ui.renderRunCardHtml(projection);
  const text = ui.visiblePlainText(html);
  const root = phrasePaintRoot();
  const session = ui.createDisplayOnlySession({ card: 'run', document: {}, root });
  assert.equal(session.paint(projection), true);
  assert.equal(projection.summary.delegating, EXPERIENCE_PHRASES.delegating);
  assert.equal(projection.summary.running, 'Co-Engineer is running 2 independent assignments');
  assert.equal(/[.!?]$/.test(projection.summary.delegating), false);
  assert.equal(runPhraseMarkup(html), joined);
  assert.equal(ui.fieldMap('run', projection).phrase, joined);
  assert.equal(root.phrase.textContent, joined);
  assert.equal(text.includes(joined), true);
  assert.equal(html.includes('I am delegating this to Co-Engineer. Co-Engineer is running 2 independent assignments'), true);
  assert.equal(html.includes('I am delegating this to Co-Engineer Co-Engineer is running'), false);
  assert.equal(html.includes('..'), false);
});

test('run card preserves existing terminal punctuation and missing running text', async () => {
  const receipt = await loadJson(RESPONSE_DIR, 'run-receipt.json');
  const base = projectExperience(receipt);
  const running = base.summary.running;
  const rows = [
    {
      delegating: EXPERIENCE_PHRASES.delegating,
      joined: `${EXPERIENCE_PHRASES.delegating}. ${running}`,
    },
    {
      delegating: `${EXPERIENCE_PHRASES.delegating}.`,
      joined: `${EXPERIENCE_PHRASES.delegating}. ${running}`,
    },
    {
      delegating: `${EXPERIENCE_PHRASES.delegating}?`,
      joined: `${EXPERIENCE_PHRASES.delegating}? ${running}`,
    },
    {
      delegating: `${EXPERIENCE_PHRASES.delegating}!`,
      joined: `${EXPERIENCE_PHRASES.delegating}! ${running}`,
    },
  ];
  for (const row of rows) {
    const next = structuredClone(base);
    next.summary.delegating = row.delegating;
    const html = ui.renderRunCardHtml(next);
    const root = phrasePaintRoot();
    ui.createDisplayOnlySession({ card: 'run', document: {}, root }).paint(next);
    assert.equal(next.summary.delegating, row.delegating, row.delegating);
    assert.equal(next.summary.running, running, row.delegating);
    assert.equal(ui.fieldMap('run', next).phrase, row.joined, row.delegating);
    assert.equal(runPhraseMarkup(html), row.joined, row.delegating);
    assert.equal(root.phrase.textContent, row.joined, row.delegating);
    assert.equal(runPhraseMarkup(html).includes('..'), false, row.delegating);
    assert.equal(runPhraseMarkup(html).includes('?.'), false, row.delegating);
    assert.equal(runPhraseMarkup(html).includes('!.'), false, row.delegating);
  }

  const missing = [undefined, null, '', '   ', 2];
  for (const runningValue of missing) {
    const next = structuredClone(base);
    next.summary.running = runningValue;
    const html = ui.renderRunCardHtml(next);
    const root = phrasePaintRoot();
    ui.createDisplayOnlySession({ card: 'run', document: {}, root }).paint(next);
    assert.equal(Object.hasOwn(next.summary, 'running') ? next.summary.running : undefined, runningValue);
    assert.equal(ui.fieldMap('run', next).phrase, EXPERIENCE_PHRASES.delegating, String(runningValue));
    assert.equal(runPhraseMarkup(html), EXPERIENCE_PHRASES.delegating, String(runningValue));
    assert.equal(root.phrase.textContent, EXPERIENCE_PHRASES.delegating, String(runningValue));
    assert.equal(html.includes('Co-Engineer is running'), false, String(runningValue));
    assert.equal(html.includes(`${EXPERIENCE_PHRASES.delegating}.`), false, String(runningValue));
  }
});

test('final card HTML buckets lanes, git identity, and evidence without action controls', async () => {
  const receipt = await loadJson(RESPONSE_DIR, 'final-receipt.json');
  const projection = projectExperience(receipt);
  const html = ui.renderFinalCardHtml(projection);
  const text = ui.visiblePlainText(html);
  assert.match(html, /<h1 id="cce-final-title">Co-Engineer final decision<\/h1>/u);
  assert.equal(text.includes('validator'), true);
  assert.equal(text.includes('docs'), true);
  assert.equal(text.includes('review'), true);
  assert.equal(text.includes('codex-co-engineer/runs/auth-split/validator'), true);
  assert.equal(text.includes('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), true);
  assert.equal(text.includes('cccccccccccccccccccccccccccccccccccccccc'), true);
  assert.equal(text.includes('git_identity'), true);
  assert.equal(text.includes('tests_passed'), true);
  assert.equal(text.includes(ui.CODEX_AUTHORITY_SENTENCE), true);
  assert.equal(text.includes('Co-Engineer finished, and I verified the candidate.'), false);
  assert.equal(ui.documentContainsActionControls(html), false);
  assert.equal(html.includes('<button'), false);
  assert.equal(html.includes('<form'), false);
  assert.equal(/\bMerge\b/.test(ui.markupWithoutScripts(html).match(/<button[\s\S]*?<\/button>/u)?.[0] ?? ''), false);
});

test('attention card groups current questions once and binds one structured reply', async () => {
  attentionUi.resetSubmittedForTests();
  const receipt = await loadJson(RESPONSE_DIR, 'attention-receipt.json');
  const projection = projectExperience(receipt);
  const html = attentionUi.renderAttentionCardHtml(projection);
  const text = attentionUi.visiblePlainText(html);
  assert.equal(projection.card, 'attention');
  assert.equal(attentionUi.groupQuestions(projection.attention).length, 2);
  assert.equal(attentionUi.answerableQuestions(projection.attention).length, 1);
  assert.match(html, /<main>/u);
  assert.match(html, /<h1 id="cce-attention-title">Co-Engineer grouped attention<\/h1>/u);
  assert.match(html, /<h2 id="cce-questions-heading">Questions<\/h2>/u);
  assert.match(html, /<h2 id="cce-affected-heading">Affected assignments<\/h2>/u);
  assert.match(html, /<h2 id="cce-unaffected-heading">Unaffected assignments<\/h2>/u);
  assert.match(html, /<ol class="cce-questions"/u);
  assert.match(html, /<label for="cce-answer-validator-stricter">/u);
  assert.equal(text.includes('Use the stricter validator?'), true);
  assert.equal(text.includes('Cloud cannot host a same-session reply'), true);
  assert.equal(text.includes('validator'), true);
  assert.equal(text.includes('cloud-review'), true);
  assert.equal(text.includes('docs'), true);
  assert.equal(text.includes('These assignments keep working.'), true);
  assert.equal(text.includes('stays unresolved'), true);
  assert.equal(text.includes(attentionUi.AUTHORITY_SENTENCE), true);
  assert.equal((html.match(/<form\b/g) || []).length, 1);
  assert.equal((html.match(/type="submit"/g) || []).length, 1);
  const bound = attentionUi.bindAttention(projection);
  assert.equal(attentionUi.missingAuthority(bound), null);
  assert.equal(bound.run_id, 'auth-split');
  assert.equal(bound.batch_id, receipt.attention.batch_id);
  assert.equal(bound.revision, 1);
  assert.equal(bound.event_cursor, '12');
  assert.equal(bound.cursor_resume, true);
  const reply = attentionUi.buildGroupedReply(bound, { validator: 'stricter' });
  assert.equal(reply.reply.answers.length, 1);
  assert.equal(reply.reply.answers[0].assignment_id, 'validator');
  assert.equal(reply.reply.round, 1);
  assert.deepEqual(Object.keys(reply).sort(), ['batch_id', 'expected_revision', 'reply']);
  assert.deepEqual(Object.keys(reply.reply).sort(), ['answers', 'batch_id', 'round']);
  assert.equal(attentionUi.validateRunReply(reply).ok, true);
  assert.equal(attentionUi.authorizeReply(bound, reply, { validator: 'stricter' }).ok, true);
  const session = attentionUi.createAttentionSession();
  session.start();
  assert.equal(session.paint(projection), true);
  const sent = session.submit({ validator: 'stricter' });
  assert.equal(sent.ok, true);
  const calls = session.outbound.filter((message) => message.method === attentionUi.TOOL_CALL_METHOD);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, 'task');
  assert.equal(calls[0].id, attentionUi.canonicalDeliveryId(bound));
  assert.equal(calls[0].id.includes(bound.event_cursor), true);
  assert.deepEqual(Object.keys(calls[0].params.arguments).sort(), ['run_id', 'run_reply']);
  assert.equal(calls[0].params.arguments.run_id, 'auth-split');
  assert.equal(calls[0].params.arguments.run_reply.expected_revision, 1);
  assert.equal(Object.hasOwn(calls[0].params.arguments.run_reply, 'event_cursor'), false);
  assert.equal(Object.hasOwn(calls[0].params.arguments.run_reply.reply, 'event_cursor'), false);
  assert.equal(session.focusPlan().target, 'cce-attention-status');
  assert.deepEqual(attentionUi.tabOrder(bound)[0], 'cce-answer-validator-stricter');
});

test('compatible MCP server lists and reads the three registered cards', async () => {
  const init = await loadJson(FIXTURE_DIR, 'compatible-client.json');
  const values = await conversation([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: init },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: INLINE_EXPERIENCE_UI_URIS.run } },
    { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: INLINE_EXPERIENCE_UI_URIS.final } },
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: INLINE_EXPERIENCE_UI_URIS.attention } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status', arguments: {} } },
  ]);
  assert.equal(values[0].result.capabilities.tools.listChanged, false);
  assert.deepEqual(
    values[0].result.capabilities.extensions[MCP_APPS_EXTENSION_ID].mimeTypes,
    [MCP_APPS_MIME_TYPE],
  );
  assert.deepEqual(values[0].result.capabilities.resources, { listChanged: false });
  assert.deepEqual(values[1].result.tools.map((tool) => tool.name), [...PUBLIC_MCP_TOOLS]);
  assert.equal(values[1].result.tools.length, 5);
  for (const tool of values[1].result.tools) {
    assert.equal(Object.hasOwn(tool, '_meta'), false);
  }
  const listed = values[2].result.resources.map((resource) => resource.uri).sort();
  assert.deepEqual(listed, [
    INLINE_EXPERIENCE_UI_URIS.attention,
    INLINE_EXPERIENCE_UI_URIS.final,
    INLINE_EXPERIENCE_UI_URIS.run,
  ].sort());
  assert.equal(values[3].result.contents[0].mimeType, MCP_APPS_MIME_TYPE);
  assert.equal(values[4].result.contents[0].mimeType, MCP_APPS_MIME_TYPE);
  assert.equal(values[5].result.contents[0].mimeType, MCP_APPS_MIME_TYPE);
  assert.match(values[3].result.contents[0].text, /data-cce-card="run"/u);
  assert.match(values[4].result.contents[0].text, /data-cce-card="final"/u);
  assert.match(values[5].result.contents[0].text, /data-cce-card="attention"/u);
  assert.match(values[5].result.contents[0].text, /aria-live="polite"/u);
  assert.equal(Object.hasOwn(values[6].result, '_meta'), false);
  assert.equal(values[6].result.content[0].text, JSON.stringify(values[6].result.structuredContent));
});

test('docs freeze host-specific unproven support and sequential ownership', async () => {
  const docs = await readFile(path.join(REPO, 'docs', 'mcp-apps-ui.md'), 'utf8');
  const contract = await loadJson(FIXTURE_DIR, 'contract.json');
  assert.match(docs, /host-specific\/unproven until QA-01/u);
  assert.equal(docs.includes(contract.support), true);
  assert.match(docs, /Grouped attention card/u);
  assert.match(docs, /exactly one bounded structured reply/u);
  assert.match(docs, /prefers-reduced-motion/u);
  assert.match(docs, /display-only/iu);
  assert.equal(docs.includes('universal UI'), true);
  assert.match(docs, /Do not claim credit reduction, 8x speed, universal UI/u);
  assert.equal(PUBLIC_MCP_TOOLS.length, 5);
  assert.match(docs, /Real-host support\s+stays unproven until QA-01/u);
});
