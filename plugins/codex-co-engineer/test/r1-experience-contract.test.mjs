// UX-01 experience contract: freeze public language, journeys, and golden
// prompt/response pairs. Downstream UX slices consume these files; this
// suite rejects internal jargon, MCP JSON for normal users, extra tools,
// and unsubstantiated claims.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const PLUGIN = path.join(REPO, 'plugins', 'codex-co-engineer');
const GOLDEN_DIR = path.join(HERE, 'fixtures', 'v3-experience-golden-prompts');
const CONTRACT_JSON = path.join(HERE, 'fixtures', 'v3-experience-contract.json');
const CONTRACT_DOC = path.join(REPO, 'docs', 'co-engineer-experience-contract.md');
const JOURNEYS_DOC = path.join(REPO, 'docs', 'co-engineer-user-journeys.md');

const JOURNEY_HEADINGS = Object.freeze({
  'one-lane': '## One-lane',
  'multi-lane': '## Multi-lane',
  'grouped-attention': '## Grouped-attention',
  'verified-final': '## Verified-final',
  'failure-unresolved': '## Failure/unresolved',
  'provider-choice': '## Provider-choice',
  'no-profile-ask-once': '## No-profile ask-once',
});

const USER_JARGON = Object.freeze([
  [/\bP\d{1,3}\b/u, 'Pxx identifier'],
  [/\bPxx\b/u, 'Pxx token'],
  [/R-TRUTH/u, 'R-TRUTH'],
  [/AttentionBatch/iu, 'AttentionBatch'],
  [/R-CUTOVER/u, 'R-CUTOVER'],
]);

const MCP_JSON_MARKERS = Object.freeze([
  [/```json/iu, 'json code fence'],
  [/"wait_until"\s*:/u, 'wait_until JSON field'],
  [/"task_id"\s*:/u, 'task_id JSON field'],
  [/"run_id"\s*:/u, 'run_id JSON field'],
]);

function fail(message) {
  throw new Error(message);
}

function folded(source) {
  return String(source).replace(/\s+/gu, ' ');
}

function isImmediatelyNegated(prefix) {
  const clause = prefix
    .split(/(?:[.;!?]|\bbut\b|\bhowever\b)/iu)
    .at(-1)
    .slice(-240);
  if (/\bnot\s+only\b/iu.test(clause)) return false;
  return /\b(?:may|might|must|shall|will|can|could|does?|did|do)\s+not\b/iu.test(clause)
    || /\b(?:never|cannot|can't)\b/iu.test(clause)
    || /\bdo not (?:claim|teach|add|imply|name)\b/iu.test(clause)
    || /\basks? for\b/iu.test(clause)
    || /\bforbidden\b/iu.test(clause)
    || /\bexclusions?\b/iu.test(clause);
}

function hasUnnegatedMatch(source, pattern) {
  const text = folded(source);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(matcher)) {
    const prefix = text.slice(Math.max(0, match.index - 320), match.index);
    if (isImmediatelyNegated(prefix)) continue;
    return true;
  }
  return false;
}

function firstUserText(example) {
  if (Array.isArray(example.turns) && example.turns.length > 0) return example.turns[0].user;
  return example.user_prompt;
}

function userTexts(example) {
  if (Array.isArray(example.turns)) return example.turns.map((turn) => turn.user);
  return [example.user_prompt];
}

function codexTexts(example) {
  if (Array.isArray(example.turns)) return example.turns.map((turn) => turn.codex);
  return [example.codex_response];
}

function allCodexText(example) {
  return codexTexts(example).join('\n');
}

function classifyActivation(userText, fixture) {
  const text = String(userText);
  for (const signal of fixture.negative_signals) {
    if (text.includes(signal)) return 'negative';
  }
  if (/\bP\d{1,3}\b/u.test(text)) return 'negative';
  if (/```json/iu.test(text) || /[{]\s*"[^"]+"\s*:/u.test(text)) return 'negative';
  if (/8x\s+(?:speed|faster)/iu.test(text) || /8×\s+(?:speed|faster)/iu.test(text)) {
    return 'negative';
  }
  for (const phrase of fixture.canonical_phrases) {
    if (text.includes(phrase)) return 'direct';
  }
  if (/\b(?:Grok|Cursor|Muse) Co-Engineer\b/u.test(text)) return 'direct';
  for (const signal of fixture.indirect_signals) {
    if (text.includes(signal)) return 'indirect';
  }
  return 'none';
}

function sectionBody(markdown, heading) {
  const start = markdown.indexOf(`${heading}\n`);
  if (start === -1) fail(`Missing heading ${heading}.`);
  const after = markdown.slice(start + heading.length + 1);
  const next = after.search(/^## /mu);
  return next === -1 ? after : after.slice(0, next);
}

function codexSpeechLines(markdown) {
  return [...markdown.matchAll(/^Codex: (.+)$/gmu)].map((match) => match[1]);
}

function assertNoUserJargon(text, label) {
  for (const [pattern, name] of USER_JARGON) {
    if (pattern.test(text)) fail(`${label} leaks ${name}.`);
  }
}

function assertNoMcpJson(text, label) {
  for (const [pattern, name] of MCP_JSON_MARKERS) {
    if (pattern.test(text)) fail(`${label} requires ${name}.`);
  }
}

function assertNoUnsubstantiatedClaims(text, fixture, label) {
  for (const claim of fixture.forbidden_claims) {
    const pattern = new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu');
    if (hasUnnegatedMatch(text, pattern)) {
      fail(`${label} asserts unsubstantiated claim ${claim}.`);
    }
  }
}

function assertFixtureShape(fixture) {
  assert.equal(fixture.schema, 'codex-co-engineer.experience-contract.v1');
  assert.equal(fixture.version, 1);
  assert.equal(
    fixture.product_lead,
    'Give Codex a team of external co-engineers without giving up control.',
  );
  assert.deepEqual(fixture.canonical_phrases, [
    'Delegating to Co-Engineer',
    'Chatting with Co-Engineer',
    'Using Grok Co-Engineer',
    'Using Cursor Co-Engineer',
    'Using Muse Co-Engineer',
  ]);
  assert.equal(fixture.codex_phrases.delegating, 'I am delegating this to Co-Engineer');
  assert.equal(
    fixture.codex_phrases.running_template,
    'Co-Engineer is running N independent assignments',
  );
  assert.equal(
    fixture.codex_phrases.running_one,
    'Co-Engineer is running 1 independent assignment',
  );
  assert.equal(fixture.codex_phrases.attention, 'Co-Engineer needs one decision from you');
  assert.equal(
    fixture.codex_phrases.verified_final,
    'Co-Engineer finished, and I verified the candidate.',
  );
  if (JSON.stringify(fixture.tools) !== JSON.stringify(['status', 'delegate', 'task', 'tasks', 'cancel'])) {
    fail('tools catalog must be exactly status, delegate, task, tasks, cancel.');
  }
  assert.equal(fixture.tools.length, 5);
  assert.equal(fixture.coordination.submissions, 1);
  assert.equal(fixture.coordination.aggregate_wait, 'decision_or_attention');
  assert.equal(fixture.coordination.aggregate_wait_count, 1);
  assert.equal(fixture.coordination.verified_final_decisions, 1);
  assert.equal(fixture.honest_claim.max_isolated_external_co_engineers, 8);
  assert.equal(
    fixture.honest_claim.statement,
    'up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision',
  );
  assert.deepEqual(fixture.chatting_actions, [
    'inspect',
    'continue',
    'answer grouped attention',
    'cancel',
  ]);
  assert.deepEqual(fixture.provider_display, {
    grok: 'Using Grok Co-Engineer',
    'cursor-local': 'Using Cursor Co-Engineer',
    'cursor-cloud': 'Using Cursor Co-Engineer',
    dsh: 'Using Muse Co-Engineer',
  });
  assert.deepEqual(fixture.forbidden_claims, [
    'credit reduction',
    '8x speed',
    'universal UI',
    'SOTA routing',
  ]);
  assert.deepEqual(fixture.forbidden_user_terms, ['Pxx', 'R-TRUTH', 'AttentionBatch', 'MCP JSON']);
  assert.deepEqual(fixture.journeys, Object.keys(JOURNEY_HEADINGS));
  assert.deepEqual(fixture.activation_classes, ['direct', 'indirect', 'negative']);
  assert.deepEqual(fixture.activation_order, ['negative', 'direct', 'indirect', 'none']);
}

function assertDocsMatchFixture(contractText, journeysText, fixture) {
  assert.match(contractText, /^# Co-Engineer experience contract\n/u);
  assert.match(journeysText, /^# Co-Engineer user journeys\n/u);
  if (!contractText.includes(fixture.product_lead)) {
    fail('experience contract missing product_lead');
  }
  if (!journeysText.includes(fixture.product_lead)) {
    fail('user journeys missing product_lead');
  }
  for (const phrase of fixture.canonical_phrases) {
    assert.equal(contractText.includes(phrase), true, `contract missing ${phrase}`);
  }
  for (const phrase of Object.values(fixture.codex_phrases)) {
    assert.equal(contractText.includes(phrase), true, `contract missing ${phrase}`);
  }
  if (!contractText.includes(fixture.honest_claim.statement)) {
    fail('experience contract missing honest_claim statement');
  }
  if (!journeysText.includes(fixture.honest_claim.statement)) {
    fail('user journeys missing honest_claim statement');
  }
  assert.match(
    contractText,
    /`status`, `delegate`, `task`, `tasks`, `cancel`/u,
  );
  assert.equal(contractText.includes('decision_or_attention'), true);
  assert.equal(contractText.includes('There is no sixth tool.'), true);
  for (const action of fixture.chatting_actions) {
    assert.equal(contractText.includes(action), true, `contract missing chatting action ${action}`);
    assert.equal(journeysText.includes(action), true, `journeys missing chatting action ${action}`);
  }
  for (const claim of fixture.forbidden_claims) {
    assert.equal(contractText.includes(claim), true, `contract must name forbidden claim ${claim}`);
  }
  for (const term of fixture.forbidden_user_terms) {
    assert.equal(contractText.includes(term), true, `contract must name exclusion ${term}`);
  }
  for (const [id, heading] of Object.entries(JOURNEY_HEADINGS)) {
    assert.equal(journeysText.includes(heading), true, `journeys missing ${id}`);
  }

  assertNoMcpJson(journeysText, 'user journeys');
  assertNoUserJargon(journeysText, 'user journeys');
  assert.doesNotMatch(journeysText, /decision_or_attention/u);
  for (const tool of fixture.tools) {
    assert.doesNotMatch(
      journeysText,
      new RegExp(`\`${tool}\``, 'u'),
      `user journeys must not require tool ${tool}`,
    );
  }

  assertNoUnsubstantiatedClaims(contractText, fixture, 'experience contract');
  assertNoUnsubstantiatedClaims(journeysText, fixture, 'user journeys');

  const failureBody = sectionBody(journeysText, JOURNEY_HEADINGS['failure-unresolved']);
  for (const line of codexSpeechLines(failureBody)) {
    assert.equal(
      line.includes(fixture.codex_phrases.verified_final),
      false,
      'failure journey Codex speech used the verified-final sentence',
    );
  }
  assert.match(folded(failureBody), /blocks a complete candidate/u);

  const verifiedBody = sectionBody(journeysText, JOURNEY_HEADINGS['verified-final']);
  assert.equal(folded(verifiedBody).includes(fixture.codex_phrases.verified_final), true);

  const groupedBody = sectionBody(journeysText, JOURNEY_HEADINGS['grouped-attention']);
  assert.equal(folded(groupedBody).includes(fixture.codex_phrases.attention), true);
  assert.match(folded(groupedBody), /not a second delegation/u);

  const askOnceBody = sectionBody(journeysText, JOURNEY_HEADINGS['no-profile-ask-once']);
  assert.match(folded(askOnceBody), /asks once/u);
  assert.match(folded(askOnceBody), /does not invent a default router/u);
}

function assertGoldenExample(example, fixture, filename) {
  assert.equal(example.id, filename.replace(/\.json$/u, ''));
  assert.equal(fixture.activation_classes.includes(example.activation), true, example.id);
  if (example.journey != null) {
    assert.equal(fixture.journeys.includes(example.journey), true, example.id);
  }
  const users = userTexts(example);
  const responses = codexTexts(example);
  assert.ok(users.length > 0 && responses.length === users.length, example.id);
  for (const text of [...users, ...responses]) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${example.id} has an empty turn`);
  }

  const activating = firstUserText(example);
  assert.equal(
    classifyActivation(activating, fixture),
    example.activation,
    `${example.id} activation class drifted`,
  );

  const response = allCodexText(example);
  for (const phrase of example.expected_phrases ?? []) {
    assert.equal(response.includes(phrase), true, `${example.id} missing ${phrase}`);
  }
  for (const banned of example.forbidden_in_response ?? []) {
    assert.equal(response.includes(banned), false, `${example.id} leaked ${banned}`);
  }
  assertNoUserJargon(response, `${example.id} Codex response`);
  assertNoMcpJson(response, `${example.id} Codex response`);
  assertNoUnsubstantiatedClaims(response, fixture, `${example.id} Codex response`);
  for (const phrase of fixture.forbidden_provider_phrases) {
    assert.equal(response.includes(phrase), false, `${example.id} used ${phrase}`);
  }

  const running = new RegExp(fixture.running_phrase_pattern, 'u');
  const coordination = example.coordination;
  assert.equal(Number.isInteger(coordination.submissions), true, example.id);
  assert.ok(coordination.submissions === 0 || coordination.submissions === 1, example.id);
  if (coordination.submissions === 1) {
    assert.equal(response.includes(fixture.codex_phrases.delegating), true, example.id);
    assert.match(response, running, example.id);
    assert.equal(coordination.aggregate_wait, 'decision_or_attention');
  }
  if (coordination.chatting === true) {
    assert.equal(response.includes('second bounded run'), false, example.id);
  }
  if (coordination.verified_final === true) {
    assert.equal(response.includes(fixture.codex_phrases.verified_final), true, example.id);
  }
  if (example.journey === 'failure-unresolved') {
    assert.equal(response.includes(fixture.codex_phrases.verified_final), false, example.id);
  }
  if (example.journey === 'grouped-attention') {
    assert.equal(response.includes(fixture.codex_phrases.attention), true, example.id);
    assert.equal(response.includes(fixture.codex_phrases.delegating), false, example.id);
  }
  if (coordination.ask_once === true) {
    const first = responses[0];
    assert.match(first, /\?/u, `${example.id} ask-once must ask a question`);
    assert.equal(first.includes(fixture.codex_phrases.delegating), false, example.id);
  }
}

function assertExperienceContract({ contractText, journeysText, fixture, goldens, manifest }) {
  if (typeof contractText !== 'string' || contractText.length === 0) {
    fail('Experience contract text is required.');
  }
  if (typeof journeysText !== 'string' || journeysText.length === 0) {
    fail('User journeys text is required.');
  }
  assertFixtureShape(fixture);
  assertDocsMatchFixture(contractText, journeysText, fixture);
  assert.equal(manifest.schema, 'codex-co-engineer.experience-golden-prompts.v1');
  const byId = new Map();
  for (const example of goldens) {
    assertGoldenExample(example, fixture, `${example.id}.json`);
    if (byId.has(example.id)) fail(`Duplicate golden id ${example.id}.`);
    byId.set(example.id, example);
  }
  for (const id of [
    'direct-delegating',
    'direct-chatting',
    'direct-using-grok',
    'direct-using-cursor',
    'direct-using-muse',
    'indirect-product-lead',
    'indirect-isolated-team',
    'negative-mcp-json',
    'negative-internal-jargon',
    'negative-unsubstantiated-claims',
  ]) {
    assert.equal(byId.has(id), true, `missing activation golden ${id}`);
  }
  for (const journey of fixture.journeys) {
    assert.equal(byId.has(`journey-${journey}`), true, `missing journey golden ${journey}`);
  }
  const classes = new Set(goldens.map((example) => example.activation));
  for (const expected of fixture.activation_classes) {
    assert.equal(classes.has(expected), true, `missing activation class ${expected}`);
  }
}

async function loadBundle() {
  const fixture = JSON.parse(await readFile(CONTRACT_JSON, 'utf8'));
  const contractText = await readFile(CONTRACT_DOC, 'utf8');
  const journeysText = await readFile(JOURNEYS_DOC, 'utf8');
  const manifest = JSON.parse(await readFile(path.join(GOLDEN_DIR, 'manifest.json'), 'utf8'));
  const goldens = [];
  for (const name of manifest.examples) {
    goldens.push(JSON.parse(await readFile(path.join(GOLDEN_DIR, name), 'utf8')));
  }
  return { fixture, contractText, journeysText, manifest, goldens };
}

test('experience contract fixture, docs, and goldens freeze public language', async () => {
  const bundle = await loadBundle();
  assertExperienceContract(bundle);
});

test('golden directory contains exactly the manifested prompt files', async () => {
  const { manifest } = await loadBundle();
  const names = (await readdir(GOLDEN_DIR)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, [...manifest.examples, 'manifest.json'].sort());
  assert.deepEqual(
    [...new Set(manifest.examples)],
    [...manifest.examples],
    'golden manifest must not repeat files',
  );
});

test('activation classifier is deterministic and negative wins', async () => {
  const { fixture } = await loadBundle();
  assert.equal(
    classifyActivation('Delegating to Co-Engineer: review the auth change.', fixture),
    'direct',
  );
  assert.equal(
    classifyActivation('Review the auth change with Grok Co-Engineer.', fixture),
    'direct',
  );
  assert.equal(
    classifyActivation('Using Cursor Co-Engineer, review the operator guide.', fixture),
    'direct',
  );
  assert.equal(
    classifyActivation(
      'Give Codex a team of external co-engineers without giving up control.',
      fixture,
    ),
    'indirect',
  );
  assert.equal(
    classifyActivation(
      'Split this into three isolated independent assignments: API, docs, review.',
      fixture,
    ),
    'indirect',
  );
  assert.equal(
    classifyActivation(
      'Delegating to Co-Engineer through this MCP JSON payload.',
      fixture,
    ),
    'negative',
  );
  assert.equal(
    classifyActivation('Show the AttentionBatch and the P34 latch.', fixture),
    'negative',
  );
  assert.equal(
    classifyActivation('Claim 8x speed and SOTA routing.', fixture),
    'negative',
  );
  assert.equal(classifyActivation('Please refactor the helper.', fixture), 'none');
});

test('running-phrase inflection stays 1 assignment and 2-8 assignments', async () => {
  const { fixture } = await loadBundle();
  const pattern = new RegExp(`^${fixture.running_phrase_pattern}$`, 'u');
  assert.equal(pattern.test(fixture.codex_phrases.running_one), true);
  for (let n = 2; n <= 8; n += 1) {
    assert.equal(pattern.test(`Co-Engineer is running ${n} independent assignments`), true, n);
  }
  assert.equal(pattern.test('Co-Engineer is running 9 independent assignments'), false);
  assert.equal(pattern.test('Co-Engineer is running 0 independent assignments'), false);
});

test('experience contract rejects jargon, sixth tools, JSON journeys, and false claims', async () => {
  const bundle = await loadBundle();

  const extraTool = structuredClone(bundle);
  extraTool.fixture.tools = [...bundle.fixture.tools, 'supervise'];
  assert.throws(() => assertExperienceContract(extraTool), /tools/u);

  const reordered = structuredClone(bundle);
  reordered.fixture.tools = ['delegate', 'status', 'task', 'tasks', 'cancel'];
  assert.throws(() => assertExperienceContract(reordered), /tools/u);

  const leadDrift = {
    ...bundle,
    contractText: bundle.contractText.replaceAll(bundle.fixture.product_lead, 'Give up control.'),
  };
  assert.throws(() => assertExperienceContract(leadDrift), /product_lead/u);

  const jsonJourneys = {
    ...bundle,
    journeysText: `${bundle.journeysText}\n\`\`\`json\n{"wait_until":"decision_or_attention"}\n\`\`\`\n`,
  };
  assert.throws(() => assertExperienceContract(jsonJourneys), /json code fence|wait_until/u);

  const jargonJourneys = {
    ...bundle,
    journeysText: `${bundle.journeysText}\nCodex reads the AttentionBatch.\n`,
  };
  assert.throws(() => assertExperienceContract(jargonJourneys), /AttentionBatch/u);

  const pxxJourneys = {
    ...bundle,
    journeysText: `${bundle.journeysText}\nSee P34 for the latch.\n`,
  };
  assert.throws(() => assertExperienceContract(pxxJourneys), /Pxx identifier/u);

  const truthJourneys = {
    ...bundle,
    journeysText: `${bundle.journeysText}\nR-TRUTH projects the receipt.\n`,
  };
  assert.throws(() => assertExperienceContract(truthJourneys), /R-TRUTH/u);

  const speedClaim = {
    ...bundle,
    journeysText: `${bundle.journeysText}\nThis offers 8x speed.\n`,
  };
  assert.throws(() => assertExperienceContract(speedClaim), /8x speed/u);

  const routingClaim = {
    ...bundle,
    contractText: `${bundle.contractText}\nThe platform provides SOTA routing.\n`,
  };
  assert.throws(() => assertExperienceContract(routingClaim), /SOTA routing/u);

  const failureVerified = structuredClone(bundle);
  const failureGolden = failureVerified.goldens.find((example) => example.id === 'journey-failure-unresolved');
  failureGolden.turns[0].codex = bundle.fixture.codex_phrases.verified_final;
  assert.throws(() => assertExperienceContract(failureVerified), /verified-final|journey-failure/u);

  const groupedDelegates = structuredClone(bundle);
  const grouped = groupedDelegates.goldens.find((example) => example.id === 'journey-grouped-attention');
  grouped.turns[1].codex = `${grouped.turns[1].codex} I am delegating this to Co-Engineer`;
  assert.throws(() => assertExperienceContract(groupedDelegates), /journey-grouped-attention/u);

  const mislabeled = structuredClone(bundle);
  const direct = mislabeled.goldens.find((example) => example.id === 'direct-delegating');
  direct.activation = 'indirect';
  assert.throws(() => assertExperienceContract(mislabeled), /activation class drifted/u);

  const dshPhrase = structuredClone(bundle);
  const grok = dshPhrase.goldens.find((example) => example.id === 'direct-using-grok');
  grok.codex_response = `${grok.codex_response} Using DSH Co-Engineer.`;
  assert.throws(() => assertExperienceContract(dshPhrase), /Using DSH Co-Engineer/u);
});

test('package tests pick up the experience contract without runtime edits', async () => {
  const packageJson = JSON.parse(await readFile(path.join(PLUGIN, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --no-warnings --test test/*.test.mjs');
  const relative = path.relative(path.join(PLUGIN, 'test'), fileURLToPath(import.meta.url));
  assert.equal(relative, 'r1-experience-contract.test.mjs');
});
