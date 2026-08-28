// UX-02 goal-oriented skills: freeze discoverable skill IDs, Advanced Control
// repositioning, and deterministic activation. Ordinary users get natural-language
// outcomes. Raw MCP/API/control-plane debugging belongs only to Advanced Control.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const SKILLS = path.join(PLUGIN, 'skills');
const FIXTURE_DIR = path.join(HERE, 'fixtures', 'v3-skill-activation');
const EXPERIENCE_CONTRACT = path.join(HERE, 'fixtures', 'v3-experience-contract.json');

const GOAL_SKILLS = Object.freeze([
  'delegate-to-co-engineer',
  'chat-with-co-engineer',
  'use-grok-co-engineer',
  'use-cursor-co-engineer',
  'use-muse-co-engineer',
]);
const ADVANCED_SKILL = 'control-codex-co-engineer-agents';
const ALL_SKILLS = Object.freeze([...GOAL_SKILLS, ADVANCED_SKILL]);
const ACTIVATION_CLASSES = Object.freeze(['direct', 'indirect', 'negative']);
const USER_JARGON = Object.freeze([
  [/\bP\d{1,3}\b/u, 'Pxx identifier'],
  [/\bPxx\b/u, 'Pxx token'],
  [/R-TRUTH/u, 'R-TRUTH'],
  [/AttentionBatch/iu, 'AttentionBatch'],
]);
const MCP_JSON_MARKERS = Object.freeze([
  [/```json/iu, 'json code fence'],
  [/"wait_until"\s*:/u, 'wait_until JSON field'],
  [/"task_id"\s*:/u, 'task_id JSON field'],
  [/"run_id"\s*:/u, 'run_id JSON field'],
]);
const PLACEHOLDER_MARKERS = Object.freeze([
  /\[TODO:/u,
  /^[ \t]*TODO:/mu,
  /FIXME/u,
]);

function fail(message) {
  throw new Error(message);
}

function hasAny(text, signals) {
  return signals.some((signal) => text.includes(signal));
}

function parseFrontmatter(content, label) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/u);
  if (!match) fail(`${label} is missing YAML frontmatter.`);
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!field) continue;
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[field[1]] = value;
  }
  return { fields, body: content.slice(match[0].length) };
}

function yamlStringLines(source) {
  const lines = [];
  for (const line of source.split('\n')) {
    const match = line.match(/^\s*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u);
    if (!match) continue;
    lines.push({ key: match[1], value: match[2], line });
  }
  return lines;
}

function parseOpenaiYaml(source, skillId) {
  const fields = {};
  for (const { key, value } of yamlStringLines(source)) {
    if (value === '') continue;
    if (value === 'true' || value === 'false') {
      fields[key] = value === 'true';
      continue;
    }
    if (!(value.startsWith('"') && value.endsWith('"'))) {
      fail(`${skillId} agents/openai.yaml must quote string ${key}.`);
    }
    fields[key] = value.slice(1, -1).replace(/\\"/gu, '"');
  }
  return fields;
}

function isOneSentence(text) {
  const trimmed = String(text).trim();
  return /^[A-Z].*\.$/u.test(trimmed) && (trimmed.match(/\./gu) || []).length === 1;
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

function classifySkillActivation(userText, catalog) {
  const text = String(userText);
  if (
    hasAny(text, catalog.mcp_authoring_signals)
    || /```json/iu.test(text)
    || /[{]\s*"[^"]+"\s*:/u.test(text)
  ) {
    return { skills: [], activation: 'negative' };
  }
  if (hasAny(text, catalog.jargon_signals) || /\bP\d{1,3}\b/u.test(text)) {
    return { skills: [], activation: 'negative' };
  }
  if (
    hasAny(text, catalog.forbidden_claim_signals)
    || /8x\s+(?:speed|faster)/iu.test(text)
    || /8×\s+(?:speed|faster)/iu.test(text)
  ) {
    return { skills: [], activation: 'negative' };
  }
  if (hasAny(text, catalog.other_negative_signals)) {
    return { skills: [], activation: 'negative' };
  }
  if (hasAny(text, catalog.control_plane_signals)) {
    return { skills: [catalog.advanced_skill], activation: 'direct' };
  }

  const chatCanonical = text.includes(catalog.canonical_skill_phrases['chat-with-co-engineer']);
  const chatIndirect = hasAny(text, catalog.chat_indirect_signals);
  if (chatCanonical || chatIndirect) {
    return {
      skills: ['chat-with-co-engineer'],
      activation: chatCanonical ? 'direct' : 'indirect',
    };
  }

  const named = [];
  for (const [skill, phrase] of Object.entries(catalog.provider_direct_patterns)) {
    if (text.includes(phrase)) named.push(skill);
  }
  if (named.length === 1) {
    return { skills: named, activation: 'direct' };
  }
  if (named.length > 1) {
    return { skills: ['delegate-to-co-engineer'], activation: 'direct' };
  }

  const providerContext = /co-engineer/iu.test(text)
    || /isolated/iu.test(text)
    || /independent assignment/iu.test(text);
  if (providerContext) {
    const nicknames = [];
    if (/\bGrok\b/u.test(text)) nicknames.push('use-grok-co-engineer');
    if (/\bCursor\b/u.test(text)) nicknames.push('use-cursor-co-engineer');
    if (/\bMuse\b/u.test(text)) nicknames.push('use-muse-co-engineer');
    if (nicknames.length === 1) {
      return { skills: nicknames, activation: 'indirect' };
    }
    if (nicknames.length > 1) {
      return { skills: ['delegate-to-co-engineer'], activation: 'indirect' };
    }
  }

  const delegateCanonical = text.includes(catalog.canonical_skill_phrases['delegate-to-co-engineer']);
  if (delegateCanonical || hasAny(text, catalog.delegate_indirect_signals)) {
    return {
      skills: ['delegate-to-co-engineer'],
      activation: delegateCanonical ? 'direct' : 'indirect',
    };
  }
  return { skills: [], activation: 'none' };
}

async function listFiles(directory) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await listFiles(target));
    else if (entry.isFile()) values.push(target);
  }
  return values;
}

async function loadBundle() {
  const catalog = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'catalog.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8'));
  const experience = JSON.parse(await readFile(EXPERIENCE_CONTRACT, 'utf8'));
  const examples = [];
  for (const name of manifest.examples) {
    examples.push(JSON.parse(await readFile(path.join(FIXTURE_DIR, name), 'utf8')));
  }
  const skillFiles = {};
  for (const skillId of ALL_SKILLS) {
    const skillMd = await readFile(path.join(SKILLS, skillId, 'SKILL.md'), 'utf8');
    const openaiYaml = await readFile(path.join(SKILLS, skillId, 'agents', 'openai.yaml'), 'utf8');
    const files = await listFiles(path.join(SKILLS, skillId));
    const pack = {};
    for (const file of files) {
      pack[path.relative(path.join(SKILLS, skillId), file)] = await readFile(file, 'utf8');
    }
    skillFiles[skillId] = { skillMd, openaiYaml, files, pack };
  }
  return { catalog, manifest, experience, examples, skillFiles };
}

function assertCatalogShape(catalog, experience) {
  assert.equal(catalog.schema, 'codex-co-engineer.skill-activation.v1');
  assert.equal(catalog.version, 1);
  assert.deepEqual(catalog.goal_skills, GOAL_SKILLS);
  assert.equal(catalog.advanced_skill, ADVANCED_SKILL);
  assert.deepEqual(
    Object.values(catalog.canonical_skill_phrases),
    experience.canonical_phrases,
  );
  assert.equal(catalog.product_lead, experience.product_lead);
  assert.equal(catalog.honest_claim, experience.honest_claim.statement);
  assert.equal(catalog.coordination.aggregate_wait, experience.coordination.aggregate_wait);
  assert.equal(catalog.coordination.submissions, 1);
  assert.equal(catalog.coordination.aggregate_wait_count, 1);
  assert.equal(catalog.coordination.verified_final_decisions, 1);
  assert.equal(catalog.coordination.same_run_cursor, true);
  assert.equal(catalog.coordination.max_isolated_external_co_engineers, 8);
  assert.equal(catalog.advanced_display_name, 'Advanced Co-Engineer Control');
  assert.equal(
    catalog.display_names[ADVANCED_SKILL],
    'Advanced Co-Engineer Control',
  );
  assert.deepEqual(catalog.forbidden_entrypoint_terms, ['Pxx', 'R-TRUTH', 'AttentionBatch']);
}

function assertExampleShape(example, filename, catalog) {
  assert.equal(example.id, filename.replace(/\.json$/u, ''));
  assert.equal(typeof example.user_prompt, 'string');
  assert.ok(example.user_prompt.length > 0, example.id);
  assert.equal(typeof example.ask_once, 'boolean');
  assert.equal(Array.isArray(example.expected_skills), true, example.id);
  assert.equal(Array.isArray(example.forbidden_skills), true, example.id);
  const allowedActivation = [...ACTIVATION_CLASSES, 'none'];
  assert.equal(allowedActivation.includes(example.activation), true, example.id);
  const classified = classifySkillActivation(example.user_prompt, catalog);
  assert.deepEqual(classified.skills, example.expected_skills, `${example.id} skills drifted`);
  assert.equal(classified.activation, example.activation, `${example.id} activation class drifted`);
  if (example.activation === 'negative' || example.activation === 'none') {
    assert.deepEqual(example.expected_skills, []);
    if (example.activation === 'none') assert.equal(example.skill, null, example.id);
  } else {
    assert.deepEqual(example.expected_skills, [example.skill]);
  }
  for (const skill of example.expected_skills) {
    assert.equal(example.forbidden_skills.includes(skill), false, example.id);
  }
  for (const skill of example.forbidden_skills) {
    assert.equal(classified.skills.includes(skill), false, `${example.id} misrouted to ${skill}`);
  }
}

function assertSkillMetadata(skillId, files, catalog) {
  const { fields, body } = parseFrontmatter(files.skillMd, skillId);
  assert.equal(fields.name, skillId);
  assert.equal(typeof fields.description, 'string');
  assert.ok(fields.description.length > 0 && fields.description.length <= 1024, skillId);
  assert.equal(fields.description.includes('<') || fields.description.includes('>'), false, skillId);
  assert.ok(body.trim().length > 0, `${skillId} missing body`);
  for (const marker of PLACEHOLDER_MARKERS) {
    assert.equal(marker.test(files.skillMd), false, `${skillId} has a placeholder`);
  }
  const names = files.files.map((file) => path.basename(file));
  assert.equal(names.includes('README.md'), false, `${skillId} has README.md`);
  assert.equal(names.includes('CHANGELOG.md'), false, `${skillId} has CHANGELOG.md`);

  const yaml = parseOpenaiYaml(files.openaiYaml, skillId);
  assert.equal(yaml.display_name, catalog.display_names[skillId], skillId);
  assert.equal(typeof yaml.short_description, 'string', skillId);
  assert.ok(
    yaml.short_description.length >= 25 && yaml.short_description.length <= 64,
    `${skillId} short_description is ${yaml.short_description.length} chars`,
  );
  assert.equal(isOneSentence(yaml.default_prompt), true, `${skillId} default_prompt must be one sentence`);
  assert.equal(
    yaml.default_prompt.includes(`$${skillId}`),
    true,
    `${skillId} default_prompt must name $${skillId}`,
  );
  assert.equal(yaml.allow_implicit_invocation, true, skillId);
  assert.equal(yaml.value, 'codex-co-engineer', skillId);
}

function assertGoalEntrypoint(skillId, files, catalog) {
  assertNoUserJargon(files.skillMd, `${skillId} SKILL.md`);
  assertNoMcpJson(files.skillMd, `${skillId} SKILL.md`);
  for (const [relative, source] of Object.entries(files.pack)) {
    assertNoUserJargon(source, `${skillId}/${relative}`);
    for (const term of catalog.forbidden_entrypoint_terms) {
      if (relative === 'SKILL.md' && source.includes(term)) {
        fail(`${skillId} entrypoint contains ${term}`);
      }
    }
  }
  const packText = Object.values(files.pack).join('\n');
  assert.equal(packText.includes('decision_or_attention'), true, `${skillId} missing aggregate wait`);
  assert.match(packText, /same run cursor/u, `${skillId} missing same run cursor`);
  assert.match(files.skillMd, /Codex remains/u, `${skillId} missing Codex authority`);
  assert.match(files.skillMd, /External workers may commit/u, `${skillId} missing worker commit authority`);
  assert.match(
    files.skillMd,
    /scoped publisher may non-force push only the task branch/u,
    `${skillId} missing scoped publisher`,
  );
  assert.match(files.skillMd, /Sol High or Sol XHigh/u, `${skillId} missing Sol merge actor`);
  assert.match(files.skillMd, /The user retains/u, `${skillId} missing retained user authority`);
  assert.doesNotMatch(
    files.skillMd,
    /reviewer and merge authority/u,
    `${skillId} still names Codex as merge authority`,
  );
  assert.match(files.skillMd, /Never ask the user to construct tool payloads/u, skillId);
  assert.match(files.skillMd, /\$control-codex-co-engineer-agents/u, skillId);
}

async function assertCoverage(examples) {
  const bySkill = new Map();
  for (const skillId of GOAL_SKILLS) bySkill.set(skillId, new Set());
  let askOnce = 0;
  let mixedProviders = 0;
  let advanced = 0;
  let none = 0;
  for (const example of examples) {
    if (example.skill && bySkill.has(example.skill)) {
      bySkill.get(example.skill).add(example.activation);
    }
    if (example.ask_once) askOnce += 1;
    if (example.id === 'delegate-direct-provider-choice') mixedProviders += 1;
    if (example.skill === ADVANCED_SKILL) advanced += 1;
    if (example.activation === 'none') none += 1;
  }
  for (const skillId of GOAL_SKILLS) {
    for (const activation of ACTIVATION_CLASSES) {
      assert.equal(
        bySkill.get(skillId).has(activation),
        true,
        `${skillId} missing ${activation} fixture`,
      );
    }
  }
  assert.ok(askOnce > 0, 'missing ask-once fixture');
  assert.ok(mixedProviders > 0, 'missing mixed-provider fixture');
  assert.ok(advanced > 0, 'missing Advanced Control fixture');
  assert.ok(none > 0, 'missing none fixture');
}

test('goal skill folders, frontmatter, and openai.yaml match the activation contract', async () => {
  const bundle = await loadBundle();
  assertCatalogShape(bundle.catalog, bundle.experience);
  const skillDirs = (await readdir(SKILLS)).sort();
  assert.deepEqual(skillDirs, [...ALL_SKILLS].sort());
  for (const skillId of ALL_SKILLS) {
    assertSkillMetadata(skillId, bundle.skillFiles[skillId], bundle.catalog);
  }
});

test('goal skill entrypoints stay jargon-free and teach natural-language outcomes', async () => {
  const bundle = await loadBundle();
  const delegate = bundle.skillFiles['delegate-to-co-engineer'].skillMd;
  assert.equal(delegate.includes(bundle.catalog.product_lead), true);
  assert.equal(delegate.includes(bundle.catalog.honest_claim), true);
  assert.match(delegate, /ask once/u);
  assert.match(delegate, /I am delegating this to Co-Engineer/u);
  assert.match(delegate, /Co-Engineer finished, and I verified the candidate\./u);

  const chat = bundle.skillFiles['chat-with-co-engineer'].skillMd;
  assert.match(chat, /Never start a run/u);
  assert.match(chat, /inspect, continue, answer grouped attention, or cancel/u);
  assert.match(chat, /Co-Engineer needs one decision from you/u);

  const grok = bundle.skillFiles['use-grok-co-engineer'].skillMd;
  assert.match(grok, /Using Grok Co-Engineer/u);
  assert.doesNotMatch(grok, /Using Muse Co-Engineer/u);
  assert.doesNotMatch(grok, /Using Cursor Co-Engineer/u);

  const cursor = bundle.skillFiles['use-cursor-co-engineer'].skillMd;
  assert.match(cursor, /Using Cursor Co-Engineer/u);
  assert.match(cursor, /do not expose internal slot names/u);

  const muse = bundle.skillFiles['use-muse-co-engineer'].skillMd;
  assert.match(muse, /Using Muse Co-Engineer/u);
  assert.match(muse, /Never say Using DSH Co-Engineer or Using Ox Co-Engineer/u);

  for (const skillId of GOAL_SKILLS) {
    assertGoalEntrypoint(skillId, bundle.skillFiles[skillId], bundle.catalog);
    for (const phrase of bundle.catalog.forbidden_provider_phrases) {
      const entry = bundle.skillFiles[skillId].skillMd;
      if (entry.includes(phrase) && !/Never say |both display as /u.test(entry)) {
        fail(`${skillId} uses forbidden public phrase ${phrase}`);
      }
    }
  }
});

test('Advanced Control remains the five-tool lifecycle skill, not the primary experience', async () => {
  const bundle = await loadBundle();
  const control = bundle.skillFiles[ADVANCED_SKILL];
  assert.match(control.skillMd, /^name: control-codex-co-engineer-agents$/mu);
  assert.match(control.skillMd, /^# Advanced Co-Engineer Control$/mu);
  assert.match(control.skillMd, /raw MCP lifecycle skill/u);
  assert.match(control.skillMd, /\$delegate-to-co-engineer/u);
  assert.match(control.skillMd, /\$chat-with-co-engineer/u);
  assert.match(control.skillMd, /property named `repo`/u);
  assert.match(control.skillMd, /"repo": "\/absolute\/path\/to\/git-worktree"/u);
  assert.match(control.skillMd, /Do not rename `repo` to `git_root`/u);
  assert.match(control.skillMd, /Cursor Cloud-only `starting_ref`/u);
  assert.match(control.skillMd, /wait_ms/u);
  assert.match(control.skillMd, /event_cursor/u);
  assert.match(control.skillMd, /Unsolicited stdio\s+callbacks/u);
  assert.match(control.skillMd, /Call `status` when provider or supervisor readiness is unknown/u);
  assert.match(control.skillMd, /Call `delegate` with a stable task ID/u);
  assert.match(control.skillMd, /Use `cancel` for explicit cancellation/u);
  for (const tool of ['status', 'delegate', 'task', 'tasks', 'cancel']) {
    assert.match(control.skillMd, new RegExp(`\`${tool}\``, 'u'), tool);
  }
  const yaml = parseOpenaiYaml(control.openaiYaml, ADVANCED_SKILL);
  assert.equal(yaml.display_name, 'Advanced Co-Engineer Control');
  assert.equal(yaml.allow_implicit_invocation, true);
  assert.doesNotMatch(control.skillMd, /best peer agent/u);
  assert.doesNotMatch(control.openaiYaml, /best peer agent/u);
});

test('activation fixtures are complete and match the deterministic classifier', async () => {
  const bundle = await loadBundle();
  assert.equal(bundle.manifest.schema, 'codex-co-engineer.skill-activation-examples.v1');
  const names = (await readdir(FIXTURE_DIR)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, [...bundle.manifest.examples, 'catalog.json', 'manifest.json'].sort());
  const byId = new Map();
  for (const example of bundle.examples) {
    assertExampleShape(example, `${example.id}.json`, bundle.catalog);
    if (byId.has(example.id)) fail(`Duplicate activation id ${example.id}.`);
    byId.set(example.id, example);
  }
  await assertCoverage(bundle.examples);

  const grok = byId.get('grok-direct-canonical');
  assert.equal(grok.forbidden_skills.includes('use-cursor-co-engineer'), true);
  assert.equal(grok.forbidden_skills.includes('use-muse-co-engineer'), true);

  const mixed = byId.get('delegate-direct-provider-choice');
  for (const skill of ['use-grok-co-engineer', 'use-cursor-co-engineer', 'use-muse-co-engineer']) {
    assert.equal(mixed.forbidden_skills.includes(skill), true, skill);
  }

  const askOnce = byId.get('delegate-indirect-product-lead');
  assert.equal(askOnce.ask_once, true);
  assert.match(bundle.skillFiles['delegate-to-co-engineer'].skillMd, /ask once/u);

  const eventCursor = byId.get('advanced-control-event-cursor');
  assert.deepEqual(eventCursor.expected_skills, [ADVANCED_SKILL]);
  assert.equal(eventCursor.forbidden_skills.includes('use-cursor-co-engineer'), true);
});

test('classifier is deterministic, negative wins, and control-plane is Advanced Control', async () => {
  const { catalog } = await loadBundle();
  assert.deepEqual(
    classifySkillActivation('Delegating to Co-Engineer: review the auth change in isolation.', catalog),
    { skills: ['delegate-to-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Review the auth change with Grok Co-Engineer.', catalog),
    { skills: ['use-grok-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Using Cursor Co-Engineer, review the operator guide.', catalog),
    { skills: ['use-cursor-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Using Muse Co-Engineer, review the isolated docs change.', catalog),
    { skills: ['use-muse-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation(
      'Give Codex a team of external co-engineers without giving up control.',
      catalog,
    ),
    { skills: ['delegate-to-co-engineer'], activation: 'indirect' },
  );
  assert.deepEqual(
    classifySkillActivation('Continue the running Co-Engineer work.', catalog),
    { skills: ['chat-with-co-engineer'], activation: 'indirect' },
  );
  assert.deepEqual(
    classifySkillActivation(
      'Use Grok Co-Engineer for the API change and Muse Co-Engineer for the docs. Keep the review on Cursor Co-Engineer.',
      catalog,
    ),
    { skills: ['delegate-to-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation(
      'Delegating to Co-Engineer through this MCP JSON payload.',
      catalog,
    ),
    { skills: [], activation: 'negative' },
  );
  assert.deepEqual(
    classifySkillActivation('Show the AttentionBatch and the P34 latch.', catalog),
    { skills: [], activation: 'negative' },
  );
  assert.deepEqual(
    classifySkillActivation('Claim 8x speed and SOTA routing.', catalog),
    { skills: [], activation: 'negative' },
  );
  assert.deepEqual(
    classifySkillActivation(
      'The wait is stuck; inspect the raw event_cursor and MCP task internals.',
      catalog,
    ),
    { skills: [ADVANCED_SKILL], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Using Cursor Co-Engineer, inspect the event_cursor internals.', catalog),
    { skills: [ADVANCED_SKILL], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Please refactor the helper.', catalog),
    { skills: [], activation: 'none' },
  );
  assert.deepEqual(
    classifySkillActivation('Using DSH Co-Engineer, review the isolated docs change.', catalog),
    { skills: [], activation: 'none' },
  );
});

test('activation contract rejects jargon entrypoints, sixth tools, and misrouted fixtures', async () => {
  const bundle = await loadBundle();

  const jargonEntrypoint = `${bundle.skillFiles['delegate-to-co-engineer'].skillMd}\nSee AttentionBatch.\n`;
  assert.throws(
    () => assertNoUserJargon(jargonEntrypoint, 'delegate-to-co-engineer SKILL.md'),
    /AttentionBatch/u,
  );
  assert.throws(
    () => assertNoUserJargon('Open the P34 latch.', 'entrypoint'),
    /Pxx identifier/u,
  );
  assert.throws(
    () => assertNoUserJargon('Project R-TRUTH.', 'entrypoint'),
    /R-TRUTH/u,
  );
  assert.throws(
    () => assertNoMcpJson('```json\n{"wait_until":"decision_or_attention"}\n```', 'entrypoint'),
    /json code fence/u,
  );

  const controlBody = bundle.skillFiles[ADVANCED_SKILL].skillMd;
  for (const tool of ['status', 'delegate', 'task', 'tasks', 'cancel']) {
    assert.match(controlBody, new RegExp(`\`${tool}\``, 'u'), tool);
  }
  assert.doesNotMatch(controlBody, /`supervise`/u);
  assert.equal(`${controlBody}\nUse \`supervise\`.\n`.includes('`supervise`'), true);

  const mislabeled = structuredClone(bundle.examples.find((example) => example.id === 'grok-direct-canonical'));
  mislabeled.activation = 'indirect';
  assert.throws(
    () => assertExampleShape(mislabeled, 'grok-direct-canonical.json', bundle.catalog),
    /activation class drifted/u,
  );

  const crossRoute = structuredClone(bundle.examples.find((example) => example.id === 'grok-direct-canonical'));
  crossRoute.expected_skills = ['use-muse-co-engineer'];
  crossRoute.skill = 'use-muse-co-engineer';
  assert.throws(
    () => assertExampleShape(crossRoute, 'grok-direct-canonical.json', bundle.catalog),
    /skills drifted/u,
  );

  const tooShort = parseOpenaiYaml(
    'interface:\n  display_name: "Delegating to Co-Engineer"\n  short_description: "Too short"\n  default_prompt: "Use $delegate-to-co-engineer to start a run."\npolicy:\n  allow_implicit_invocation: true\n',
    'delegate-to-co-engineer',
  );
  assert.equal(tooShort.short_description.length < 25, true);

  assert.throws(
    () => parseOpenaiYaml(
      'interface:\n  display_name: Delegating to Co-Engineer\n  short_description: "Start one bounded Co-Engineer run"\n  default_prompt: "Use $delegate-to-co-engineer to start a run."\npolicy:\n  allow_implicit_invocation: true\n',
      'delegate-to-co-engineer',
    ),
    /must quote string display_name/u,
  );
});

test('Delegating and Chatting teach Luna Max PM without a sixth public skill', async () => {
  const bundle = await loadBundle();
  const skillDirs = (await readdir(SKILLS)).sort();
  assert.deepEqual(skillDirs, [...ALL_SKILLS].sort());
  assert.equal(skillDirs.includes('luna-max-pm'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(bundle.catalog.canonical_skill_phrases, 'luna-max-pm'), false);

  const { skillRequiredPhrases } = await import('../skills/delegate-to-co-engineer/references/luna-pm-relay.mjs');
  const phrases = skillRequiredPhrases();
  const delegatePack = Object.values(bundle.skillFiles['delegate-to-co-engineer'].pack).join('\n');
  const chatPack = Object.values(bundle.skillFiles['chat-with-co-engineer'].pack).join('\n');
  for (const phrase of phrases) {
    assert.equal(delegatePack.includes(phrase), true, `delegate pack missing ${phrase}`);
    assert.equal(chatPack.includes(phrase), true, `chat pack missing ${phrase}`);
  }
  assert.match(bundle.skillFiles['delegate-to-co-engineer'].skillMd, /pin one Luna Max task/u);
  assert.match(bundle.skillFiles['chat-with-co-engineer'].skillMd, /Normal completion does not wake Sol/u);
  assert.match(delegatePack, /I am not substituting Sol/u);
  assert.match(chatPack, /I am not substituting Sol/u);

  const byId = new Map(bundle.examples.map((example) => [example.id, example]));
  assert.equal(byId.get('delegate-direct-luna-pm').skill, 'delegate-to-co-engineer');
  assert.equal(byId.get('chat-direct-luna-blocked').skill, 'chat-with-co-engineer');
  assert.equal(byId.get('none-luna-without-co-engineer').activation, 'none');
});

test('classifier keeps Luna Max on Delegating or Chatting and does not invent a Luna skill', async () => {
  const { catalog } = await loadBundle();
  assert.deepEqual(
    classifySkillActivation(
      'Delegating to Co-Engineer: pin Luna Max as the project manager for this isolated review.',
      catalog,
    ),
    { skills: ['delegate-to-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation(
      'Chatting with Co-Engineer: Luna Max reported a blocked assignment.',
      catalog,
    ),
    { skills: ['chat-with-co-engineer'], activation: 'direct' },
  );
  assert.deepEqual(
    classifySkillActivation('Use Luna Max for a local analysis of this helper.', catalog),
    { skills: [], activation: 'none' },
  );
  assert.deepEqual(
    classifySkillActivation('Using Luna Co-Engineer, review the isolated docs change.', catalog),
    { skills: [], activation: 'none' },
  );
});

test('package tests pick up skill activation without runtime edits', async () => {
  const packageJson = JSON.parse(await readFile(path.join(PLUGIN, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.test, 'node --no-warnings --test test/*.test.mjs');
  const relative = path.relative(path.join(PLUGIN, 'test'), fileURLToPath(import.meta.url));
  assert.equal(relative, 'r1-skill-activation.test.mjs');
  const experience = JSON.parse(await readFile(EXPERIENCE_CONTRACT, 'utf8'));
  assert.equal(
    experience.product_lead,
    'Give Codex a team of external co-engineers without giving up control.',
  );
  const contractDoc = await readFile(path.join(REPO, 'docs', 'co-engineer-experience-contract.md'), 'utf8');
  assert.match(contractDoc, /Give Codex a team of external co-engineers without giving up control\./u);
});
