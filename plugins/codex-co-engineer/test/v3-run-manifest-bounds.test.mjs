// Runtime tests for RunManifestV1 bounds and strict unknown-key rejection
// (P02, commit 4 of 4). Every bound is exercised at runtime through
// validateCompleteRunManifestV1: identifier grammars, immutable SHA and
// repository-path rules, byte-counted Unicode prompt/objective boundaries
// (including exactly-at-limit acceptance), timeout and duration ranges,
// acceptance-command limits with command-ID-only semantics, forbidden
// credential/executable/authority/replay/direct-mode keys at multiple
// depths, required keys with no hidden defaults, the manifest depth cap,
// and deterministic first-error reporting independent of input key order.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTANCE_MAX_COMMANDS,
  ASSIGNMENT_ID_MAX,
  ASSIGNMENT_ID_PATTERN,
  COMMAND_ID_PATTERN,
  MAX_ASSIGNMENTS,
  MAX_EXPECTED_DURATION_MS,
  MAX_MANIFEST_DEPTH,
  MAX_MANIFEST_KEY_BYTES,
  MAX_MANIFEST_NODES,
  MAX_MANIFEST_TOTAL_STRING_BYTES,
  MAX_TIMEOUT_MS,
  MIN_DURATION_MS,
  MIN_TIMEOUT_MS,
  PARAMS_MAX_KEYS,
  PARAM_VALUE_MAX_BYTES,
  PROMPT_MAX_BYTES,
  RUN_ID_PATTERN,
  SCOPE_SEGMENT_MAX_BYTES,
  RunContractV1Error,
  SHA40_PATTERN,
  validateRunManifestEnvelopeV1,
} from '../mcp/v3/run-manifest.mjs';
import { validateResolvedStartingRefV1 } from '../mcp/v3/assignment-manifest.mjs';
import {
  parseRunManifestV1,
  validateCompleteRunManifestV1,
  validateRunManifestV1,
} from '../mcp/v3/run-policy.mjs';

const BASE_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const POLICY = Object.freeze({
  max_concurrency: 4,
  require_same_base: true,
  require_disjoint_writer_scopes: true,
  allow_post_dispatch_fallback: false,
  allow_merge: false,
  allow_create_pr: false,
  attention_mode: 'aggregate',
  completion_mode: 'all_settled_then_verify',
});

function writer(id = 'lane-0', scopes = ['src/**']) {
  return {
    assignment_id: id,
    role: 'implement',
    access: 'writer',
    prompt: 'Implement the bounded change.',
    execution: { provider: 'dsh', model: 'stealth/ox-alpha' },
    write_scope: scopes,
    acceptance: [{ command_id: 'unit-tests', timeout_ms: 600_000 }],
    expected_duration_ms: 1_200_000,
    required_evidence: ['provider_report', 'git_diff'],
  };
}

function validRun() {
  return {
    schema: 'codex-co-engineer.run.v1',
    run_id: 'bounds-run-20260821',
    repository: { path: '/repos/demo', base_sha: BASE_SHA },
    objective: 'Enforce runtime bounds.',
    assignments: [writer()],
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  };
}

function violation(mutate) {
  const manifest = validRun();
  mutate(manifest);
  try {
    validateCompleteRunManifestV1(manifest);
  } catch (error) {
    assert.ok(error instanceof RunContractV1Error);
    return error;
  }
  assert.fail('expected the mutated manifest to be rejected');
}

test('happy-path run validates to a frozen bounded summary', () => {
  const summary = validateCompleteRunManifestV1(validRun());
  assert.ok(Object.isFrozen(summary));
  assert.equal(summary.run_id, 'bounds-run-20260821');
  assert.deepEqual([...summary.assignment_ids], ['lane-0']);
});

test('run IDs enforce the git-ref-safe lowercase grammar', () => {
  assert.match('abc', RUN_ID_PATTERN);
  const cases = [
    ['ab', 'too short'], ['a'.repeat(64), null], ['a'.repeat(65), 'too long'],
    ['Abc', 'uppercase'], ['1bc', 'leading digit'], ['a_b', 'underscore ok'],
    ['café-run', 'non-ascii'], ['a b', 'space'], ['-lead', 'leading hyphen'],
  ];
  for (const [value] of cases) {
    if (RUN_ID_PATTERN.test(value)) continue;
    const error = violation((m) => { m.run_id = value; });
    assert.equal(error.code, 'invalid_format');
    assert.equal(error.path, 'run_id');
  }
  const summary = validateCompleteRunManifestV1({ ...validRun(), run_id: 'a'.repeat(64) });
  assert.equal(summary.run_id, 'a'.repeat(64));
});

test('assignment IDs enforce their grammar and length bound', () => {
  assert.match(String(ASSIGNMENT_ID_PATTERN), /\{0,63\}/u);
  assert.equal(ASSIGNMENT_ID_MAX, 64);
  const error = violation((m) => { m.assignments[0].assignment_id = 'Lane-0'; });
  assert.equal(error.code, 'invalid_format');
  assert.equal(error.path, 'assignments[0].assignment_id');
});

test('base SHAs must be exact 40-character lowercase hex', () => {
  assert.match(BASE_SHA, SHA40_PATTERN);
  for (const bad of ['z'.repeat(40), BASE_SHA.slice(1), `${BASE_SHA}0`, BASE_SHA.toUpperCase(), 'a'.repeat(39)]) {
    const error = violation((m) => { m.repository.base_sha = bad; });
    assert.equal(error.code, 'invalid_format');
    assert.equal(error.path, 'repository.base_sha');
  }
});

test('repository paths must be absolute, normalized, and bounded', () => {
  for (const [bad, code] of [
    ['repos/demo', 'invalid_format'], ['/repos/demo/', 'invalid_format'],
    ['/repos/../etc', 'invalid_format'], ['/repos//demo', 'invalid_format'],
    ['/repos/./demo', 'invalid_format'], ['/repos/de\tmo', 'invalid_format'],
    [`/repos/${'d'.repeat(5000)}`, 'out_of_range'],
  ]) {
    const error = violation((m) => { m.repository.path = bad; });
    assert.equal(error.code, code, `path ${JSON.stringify(bad).slice(0, 30)}`);
    assert.equal(error.path, 'repository.path');
  }
});

test('objective bounds are byte-counted across Unicode boundaries', () => {
  assert.equal(PROMPT_MAX_BYTES, 16_384);
  const fourKilobytesOfE = 'é'.repeat(2048); // exactly 4096 bytes
  validateCompleteRunManifestV1({ ...validRun(), objective: fourKilobytesOfE });
  const error = violation((m) => { m.objective = `${fourKilobytesOfE}x`; });
  assert.equal(error.code, 'out_of_range');
  assert.equal(error.path, 'objective');
  assert.match(error.message, /4097 bytes; maximum is 4096/u);
});

test('prompts accept exactly-at-limit multi-byte content and reject one unit more', () => {
  const atLimit = '🚀'.repeat(4096); // 4 bytes each => exactly 16384 bytes
  const manifest = validRun();
  manifest.assignments[0].prompt = atLimit;
  validateCompleteRunManifestV1(manifest);

  const overLimit = violation((m) => { m.assignments[0].prompt = `${atLimit}🚀`; });
  assert.equal(overLimit.code, 'out_of_range');
  assert.equal(overLimit.path, 'assignments[0].prompt');
  assert.match(overLimit.message, /maximum is 16384/u);

  const combiningAtLimit = 'e'.repeat(PROMPT_MAX_BYTES - 2) + 'é';
  const edgeManifest = validRun();
  edgeManifest.assignments[0].prompt = combiningAtLimit;
  validateCompleteRunManifestV1(edgeManifest);
});

test('prompts must be well-formed UTF-8 without control characters or blank text', () => {
  const loneSurrogate = violation((m) => { m.assignments[0].prompt = 'bad \uD800 pair'; });
  assert.equal(loneSurrogate.code, 'invalid_format');
  assert.match(loneSurrogate.message, /lone surrogate/u);

  const carriageReturn = violation((m) => { m.assignments[0].prompt = 'line\r\nbroken'; });
  assert.equal(carriageReturn.code, 'invalid_format');

  const nulByte = violation((m) => { m.assignments[0].prompt = 'nul\u0000byte'; });
  assert.equal(nulByte.code, 'invalid_format');

  assert.doesNotThrow(() => {
    const newlinesOk = validRun();
    newlinesOk.assignments[0].prompt = 'paragraph\n\nwith\ttabs preserved';
    validateCompleteRunManifestV1(newlinesOk);
  });

  const blank = violation((m) => { m.assignments[0].prompt = '   \n\t '; });
  assert.equal(blank.code, 'empty_text');

  const empty = violation((m) => { m.assignments[0].prompt = ''; });
  assert.equal(empty.code, 'empty_text');
});

test('timeouts and expected durations honor the 3.2.1 deadline math', () => {
  assert.equal(MIN_TIMEOUT_MS, MIN_DURATION_MS);
  assert.equal(MAX_TIMEOUT_MS, Math.ceil(MAX_EXPECTED_DURATION_MS * 1.2));

  validateCompleteRunManifestV1(validRun()); // 600000 ms inside both ranges

  const belowMin = violation((m) => { m.assignments[0].acceptance[0].timeout_ms = MIN_TIMEOUT_MS - 1; });
  assert.equal(belowMin.code, 'out_of_range');
  const aboveMax = violation((m) => { m.assignments[0].acceptance[0].timeout_ms = MAX_TIMEOUT_MS + 1; });
  assert.equal(aboveMax.code, 'out_of_range');
  const floatTimeout = violation((m) => { m.assignments[0].acceptance[0].timeout_ms = 600.5; });
  assert.equal(floatTimeout.code, 'invalid_type');
  const stringTimeout = violation((m) => { m.assignments[0].acceptance[0].timeout_ms = '600000'; });
  assert.equal(stringTimeout.code, 'invalid_type');

  const durationEdge = validRun();
  durationEdge.assignments[0].expected_duration_ms = MAX_EXPECTED_DURATION_MS;
  validateCompleteRunManifestV1(durationEdge);
  const beyondDuration = violation((m) => { m.assignments[0].expected_duration_ms = MAX_EXPECTED_DURATION_MS + 1; });
  assert.equal(beyondDuration.code, 'out_of_range');
  const missingDuration = violation((m) => { delete m.assignments[0].expected_duration_ms; });
  assert.equal(missingDuration.code, 'missing_key');
  assert.match(missingDuration.message, /no hidden default/u);
});

test('acceptance arrays cap at eight approved-command references', () => {
  const eightCommands = Array.from({ length: ACCEPTANCE_MAX_COMMANDS }, (_, i) => ({
    command_id: `cmd-${i}`,
    timeout_ms: 60_000,
  }));
  const full = validRun();
  full.assignments[0].acceptance = eightCommands;
  validateCompleteRunManifestV1(full);

  const nine = violation((m) => {
    m.assignments[0].acceptance = [...eightCommands, { command_id: 'cmd-8', timeout_ms: 60_000 }];
  });
  assert.equal(nine.code, 'out_of_range');
  assert.match(nine.message, /exceeds 8/u);

  const duplicate = violation((m) => {
    m.assignments[0].acceptance = [
      { command_id: 'unit-tests', timeout_ms: 60_000 },
      { command_id: 'unit-tests', timeout_ms: 120_000 },
    ];
  });
  assert.equal(duplicate.code, 'duplicate_command_id');

  const noTimeout = violation((m) => {
    m.assignments[0].acceptance = [{ command_id: 'unit-tests' }];
  });
  assert.equal(noTimeout.code, 'missing_key');
  assert.match(noTimeout.message, /no hidden default/u);
});

test('manifests carry command IDs only; argv and executables are denied at any depth', () => {
  for (const key of ['command', 'argv', 'executable', 'shell', 'script']) {
    const inEntry = violation((m) => { m.assignments[0].acceptance[0][key] = ['npm', 'test']; });
    assert.equal(inEntry.code, 'executable_content_denied', key);
    assert.equal(inEntry.path, `assignments[0].acceptance[0].${key}`);

    const onAssignment = violation((m) => { m.assignments[0][key] = 'rm -rf /'; });
    assert.equal(onAssignment.code, 'executable_content_denied', key);
    assert.equal(onAssignment.path, `assignments[0].${key}`);
  }
});

test('credential keys are denied everywhere they appear', () => {
  const spots = [
    [(m) => { m.api_key = 'sk-secret'; }, '$.api_key'],
    [(m) => { m.assignments[0].secrets = {}; }, 'assignments[0].secrets'],
    [(m) => { m.assignments[0].execution.token = 'tok'; }, 'assignments[0].execution.token'],
    [(m) => { m.policy.authorization = 'Bearer x'; }, 'policy.authorization'],
    [(m) => { m.assignments[0].acceptance[0].parameters = { token: 't' }; },
      'assignments[0].acceptance[0].parameters.token'],
  ];
  for (const [mutate, expectedPath] of spots) {
    const error = violation(mutate);
    assert.equal(error.code, 'credential_content_denied');
    assert.equal(error.path, expectedPath);
  }
});

test('merge, push, create-pr, and protected-ref authority cannot be expressed', () => {
  const mergeTrue = violation((m) => { m.policy.allow_merge = true; });
  assert.equal(mergeTrue.code, 'merge_authority_denied');
  assert.match(mergeTrue.message, /explicit literal false/u);

  const createPrTrue = violation((m) => { m.policy.allow_create_pr = true; });
  assert.equal(createPrTrue.code, 'merge_authority_denied');

  const pushKey = violation((m) => { m.policy.allow_push = true; });
  assert.equal(pushKey.code, 'merge_authority_denied');
  assert.equal(pushKey.path, 'policy.allow_push');

  const rootPrKey = violation((m) => { m.create_pr = true; });
  assert.equal(rootPrKey.code, 'merge_authority_denied');

  const assignmentMerge = violation((m) => { m.assignments[0].allow_merge = true; });
  assert.equal(assignmentMerge.code, 'merge_authority_denied');
});

test('replay and fallback opt-ins are denied; the safety literal stays mandatory false', () => {
  const optIn = violation((m) => { m.policy.allow_post_dispatch_fallback = true; });
  assert.equal(optIn.code, 'replay_or_fallback_denied');

  const foreignFallback = violation((m) => { m.assignments[0].fallback_provider = 'grok'; });
  assert.equal(foreignFallback.code, 'replay_or_fallback_denied');

  const replayKey = violation((m) => { m.policy.allow_replay = true; });
  assert.equal(replayKey.code, 'replay_or_fallback_denied');
});

test('run submissions never express direct or managed workspace modes', () => {
  for (const [mutate, expectedPath] of [
    [(m) => { m.workspace_mode = 'direct'; }, '$.workspace_mode'],
    [(m) => { m.workspace_mode = 'managed'; }, '$.workspace_mode'],
    [(m) => { m.assignments[0].workspace_mode = 'direct'; }, 'assignments[0].workspace_mode'],
  ]) {
    const error = violation(mutate);
    assert.equal(error.code, 'direct_mode_rejected');
    assert.equal(error.path, expectedPath);
  }
});

test('unknown keys are rejected at every object depth with exact paths', () => {
  const depths = [
    [(m) => { m.extra = 1; }, '$.extra', 'unknown_key'],
    [(m) => { m.repository.shallow = true; }, 'repository.shallow', 'unknown_key'],
    [(m) => { m.assignments[0].priority = 'high'; }, 'assignments[0].priority', 'unknown_key'],
    [(m) => { m.assignments[0].execution.timeout_policy = 'fail'; }, 'assignments[0].execution.timeout_policy', 'unknown_key'],
    [(m) => { m.assignments[0].acceptance[0].env = {}; }, 'assignments[0].acceptance[0].env', 'executable_content_denied'],
    [(m) => { m.return_contract.format = 'json'; }, 'return_contract.format', 'unknown_key'],
  ];
  for (const [mutate, expectedPath, expectedCode] of depths) {
    const error = violation(mutate);
    assert.equal(error.code, expectedCode);
    assert.equal(error.path, expectedPath);
  }

  const policyUnknown = violation((m) => { m.policy.notes = 'why'; });
  assert.equal(policyUnknown.code, 'unknown_key');
  assert.equal(policyUnknown.path, 'policy.notes');
});

test('every policy key is required; none may be defaulted', () => {
  for (const key of Object.keys(POLICY)) {
    const error = violation((m) => { delete m.policy[key]; });
    assert.equal(error.code, 'missing_key', key);
    assert.equal(error.path, `policy.${key}`);
    assert.match(error.message, /no hidden defaults/u);
  }

  const concurrencyRange = violation((m) => { m.policy.max_concurrency = MAX_ASSIGNMENTS + 1; });
  assert.equal(concurrencyRange.code, 'out_of_range');
  const concurrencyType = violation((m) => { m.policy.max_concurrency = 'all'; });
  assert.equal(concurrencyType.code, 'invalid_type');
  const attentionMode = violation((m) => { m.policy.attention_mode = 'per_event'; });
  assert.equal(attentionMode.code, 'invalid_format');
  const completionMode = violation((m) => { m.policy.completion_mode = 'first_success'; });
  assert.equal(completionMode.code, 'invalid_format');
});

test('required assignment fields have no hidden defaults', () => {
  for (const key of ['write_scope', 'acceptance', 'required_evidence', 'prompt']) {
    const error = violation((m) => { delete m.assignments[0][key]; });
    assert.equal(error.code, 'missing_key', key);
  }
  assert.match(violation((m) => { delete m.assignments[0].required_evidence; }).message,
    /evidence obligations are explicit/u);
});

test('profiles are names only: never inline objects, paths, or dual choices', () => {
  const numericPrefix = validRun();
  numericPrefix.assignments[0].execution = { profile: '3-review' };
  validateRunManifestV1(numericPrefix);

  const inlineProfile = violation((m) => {
    m.assignments[0].execution = { profile: { name: 'deep-review', provider: 'dsh' } };
  });
  assert.equal(inlineProfile.code, 'invalid_type');
  assert.match(inlineProfile.message, /data references, never inline objects/u);

  const dualChoice = violation((m) => {
    m.assignments[0].execution = { profile: 'deep-review', provider: 'dsh', model: 'stealth/ox-alpha' };
  });
  assert.equal(dualChoice.code, 'execution_ambiguous');

  const neitherChoice = violation((m) => { m.assignments[0].execution = {}; });
  assert.equal(neitherChoice.code, 'execution_missing');

  const providerOnly = violation((m) => { m.assignments[0].execution = { provider: 'dsh' }; });
  assert.equal(providerOnly.code, 'missing_key');

  const pathLikeName = violation((m) => {
    m.assignments[0].execution = { profile: '../owner/profile' };
  });
  assert.equal(pathLikeName.code, 'invalid_format');
  assert.match(pathLikeName.message, /profile-name grammar/u);

  const unknownProvider = violation((m) => {
    m.assignments[0].execution = { provider: 'sky-net', model: 'x' };
  });
  assert.equal(unknownProvider.code, 'unknown_provider');
});

test('cursor-cloud lanes require exact pushed SHAs; local lanes forbid them', () => {
  const cloudMissing = violation((m) => {
    m.assignments[0].execution = { provider: 'cursor-cloud', model: 'composer-1' };
  });
  assert.equal(cloudMissing.code, 'cloud_starting_ref_required');

  const cloudOk = validRun();
  cloudOk.assignments[0].execution = { provider: 'cursor-cloud', model: 'composer-1' };
  cloudOk.assignments[0].starting_ref = BASE_SHA;
  validateCompleteRunManifestV1(cloudOk);

  const cloudShort = violation((m) => {
    m.assignments[0].execution = { provider: 'cursor-cloud', model: 'composer-1' };
    m.assignments[0].starting_ref = BASE_SHA.slice(0, 39);
  });
  assert.equal(cloudShort.code, 'invalid_format');
  const cloudUpper = violation((m) => {
    m.assignments[0].execution = { provider: 'cursor-cloud', model: 'composer-1' };
    m.assignments[0].starting_ref = BASE_SHA.toUpperCase();
  });
  assert.equal(cloudUpper.code, 'invalid_format');

  const localRef = violation((m) => { m.assignments[0].starting_ref = BASE_SHA; });
  assert.equal(localRef.code, 'starting_ref_forbidden_local');
});

test('roles map to access modes; read-only lanes stay read-only', () => {
  const mismatch = violation((m) => { m.assignments[0].role = 'review'; });
  assert.equal(mismatch.code, 'role_access_mismatch');

  const unknownRole = violation((m) => { m.assignments[0].role = 'architect'; });
  assert.equal(unknownRole.code, 'unknown_role');

  const writerWithEmptyScope = violation((m) => { m.assignments[0].write_scope = []; });
  assert.equal(writerWithEmptyScope.code, 'out_of_range');

  const readOnly = validRun();
  readOnly.assignments[0].role = 'review';
  readOnly.assignments[0].access = 'read_only';
  readOnly.assignments[0].write_scope = [];
  validateCompleteRunManifestV1(readOnly);

  const readOnlyWithScope = violation((m) => {
    m.assignments[0].role = 'review';
    m.assignments[0].access = 'read_only';
    m.assignments[0].execution = { profile: 'deep-security-review' };
    m.assignments[0].write_scope = ['src/**'];
  });
  assert.equal(readOnlyWithScope.code, 'out_of_range');
  assert.match(readOnlyWithScope.message, /read-only/u);
});

test('required evidence uses the closed duplicate-free vocabulary', () => {
  const unknownKind = violation((m) => { m.assignments[0].required_evidence = ['vibes']; });
  assert.equal(unknownKind.code, 'unknown_evidence_kind');
  const empty = violation((m) => { m.assignments[0].required_evidence = []; });
  assert.equal(empty.code, 'out_of_range');
  const duplicated = violation((m) => {
    m.assignments[0].required_evidence = ['git_diff', 'git_diff'];
  });
  assert.equal(duplicated.code, 'duplicate_evidence_kind');
});

test('acceptance parameters stay flat, bounded, and scalar', () => {
  const nested = violation((m) => {
    m.assignments[0].acceptance[0].parameters = { where: { deep: true } };
  });
  assert.equal(nested.code, 'invalid_type');
  assert.match(nested.message, /flat scalars/u);

  const tooManyKeys = violation((m) => {
    m.assignments[0].acceptance[0].parameters = Object.fromEntries(
      Array.from({ length: PARAMS_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
    );
  });
  assert.equal(tooManyKeys.code, 'out_of_range');

  const oversizedValue = violation((m) => {
    m.assignments[0].acceptance[0].parameters = { name: 'x'.repeat(PARAM_VALUE_MAX_BYTES + 1) };
  });
  assert.equal(oversizedValue.code, 'out_of_range');

  const badKeyName = violation((m) => {
    m.assignments[0].acceptance[0].parameters = { 'Bad Key': 1 };
  });
  assert.equal(badKeyName.code, 'invalid_format');

  const scalarsOk = validRun();
  scalarsOk.assignments[0].acceptance[0].parameters = {
    suite: 'unit', shard: 3, verbose: true,
  };
  validateCompleteRunManifestV1(scalarsOk);
});

test('hostile nesting hits the deterministic depth cap before anything else', () => {
  let deep = 'leaf';
  for (let i = 0; i < MAX_MANIFEST_DEPTH + 8; i += 1) deep = { nested: deep };
  const error = violation((m) => { m.assignments[0].note = deep; });
  assert.equal(error.code, 'depth_exceeded');
  assert.match(error.path, /^assignments\[0\]\.note/u);
});

test('the parser rejects extremely deep input with a typed bounded error before cloning', () => {
  let deep = 'leaf';
  for (let i = 0; i < 6_000; i += 1) deep = { nested: deep };
  assert.throws(
    () => parseRunManifestV1(deep),
    (error) => error instanceof RunContractV1Error
      && error.code === 'depth_exceeded'
      && error.path.length < 512
      && error.message.length < 768,
  );
});

test('first-error reporting is independent of input key insertion order', () => {
  const build = () => ({
    schema: 'codex-co-engineer.run.v1',
    zzz_unknown: 1,
    aaa_unknown: 2,
    run_id: 'determinism-check',
    repository: { base_sha: BASE_SHA, path: '/repos/demo' },
    objective: 'Deterministic failures.',
    assignments: [],
    policy: { ...POLICY },
    return_contract: { mode: 'verified_decision', include_artifact_refs: true },
  });
  const reordered = build();
  delete reordered.zzz_unknown;
  reordered.zzz_unknown = 1;
  const first = (() => { try { validateCompleteRunManifestV1(build()); } catch (e) { return e; } })();
  const second = (() => { try { validateCompleteRunManifestV1(reordered); } catch (e) { return e; } })();
  assert.equal(first.code, second.code);
  assert.equal(first.path, second.path);
  assert.equal(first.message, second.message);
  assert.equal(first.code, 'unknown_key');
  assert.equal(first.path, '$.aaa_unknown');
});

test('the public validator is always complete and the envelope composer fails closed without hooks', () => {
  const manifest = validRun();
  const safe = validateRunManifestV1(manifest);
  assert.equal(safe.validation_depth, 'complete');
  assert.deepEqual(safe, validateCompleteRunManifestV1(manifest));
  assert.throws(
    () => validateRunManifestEnvelopeV1(manifest),
    (error) => error instanceof RunContractV1Error && error.code === 'incomplete_validator',
  );
});

test('direct-JavaScript prototype, accessor, symbol, sparse-array, and extra-array surfaces fail closed', () => {
  const inherited = validRun();
  Object.setPrototypeOf(inherited.assignments[0], { argv: ['sh'], depends_on: ['other'] });
  assert.throws(
    () => validateRunManifestV1(inherited),
    (error) => error.code === 'invalid_type' && /assignments\[0\]/u.test(error.path),
  );

  const accessor = validRun();
  let getterCalls = 0;
  Object.defineProperty(accessor.assignments[0], 'prompt', {
    enumerable: true,
    get() { getterCalls += 1; return 'must not execute'; },
  });
  assert.throws(() => validateRunManifestV1(accessor), (error) => error.code === 'invalid_object');
  assert.equal(getterCalls, 0, 'validation must reject accessors without invoking them');

  const symbolKey = validRun();
  symbolKey[Symbol('argv')] = ['sh'];
  assert.throws(() => validateRunManifestV1(symbolKey), (error) => error.code === 'invalid_object');

  const sparse = validRun();
  sparse.assignments.length = 2;
  assert.throws(() => validateRunManifestV1(sparse), (error) => error.code === 'invalid_array');

  const decorated = validRun();
  decorated.assignments.note = 'hidden';
  assert.throws(() => validateRunManifestV1(decorated), (error) => error.code === 'invalid_array');

  const inheritedArray = validRun();
  Object.setPrototypeOf(inheritedArray.assignments, { argv: ['sh'] });
  assert.throws(() => validateRunManifestV1(inheritedArray), (error) => error.code === 'invalid_array');

  const nullPrototype = validRun();
  nullPrototype.assignments[0] = Object.assign(Object.create(null), nullPrototype.assignments[0]);
  validateRunManifestV1(nullPrototype);
});

test('profile lanes are explicitly unresolved and preserve a future exact Cloud pin', () => {
  const pinned = validRun();
  pinned.assignments[0].execution = { profile: 'cloud-fast' };
  pinned.assignments[0].starting_ref = BASE_SHA;
  const pinnedSummary = validateRunManifestV1(pinned);
  assert.equal(pinnedSummary.profile_resolution_required, true);
  assert.deepEqual([...pinnedSummary.unresolved_profile_assignment_ids], ['lane-0']);
  validateResolvedStartingRefV1(pinned.assignments[0], 'cursor-cloud', 'assignments[0]');
  assert.throws(
    () => validateResolvedStartingRefV1(pinned.assignments[0], 'dsh', 'assignments[0]'),
    (error) => error.code === 'starting_ref_forbidden_local',
  );

  const unpinned = validRun();
  unpinned.assignments[0].execution = { profile: 'maybe-cloud' };
  const unpinnedSummary = validateRunManifestV1(unpinned);
  assert.equal(unpinnedSummary.profile_resolution_required, true);
  assert.throws(
    () => validateResolvedStartingRefV1(unpinned.assignments[0], 'cursor-cloud', 'assignments[0]'),
    (error) => error.code === 'cloud_starting_ref_required',
  );
  validateResolvedStartingRefV1(unpinned.assignments[0], 'grok', 'assignments[0]');
});

test('the parser returns a detached deeply frozen manifest graph', () => {
  const source = validRun();
  const parsed = parseRunManifestV1(source);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.assignments));
  assert.ok(Object.isFrozen(parsed.assignments[0]));
  assert.ok(Object.isFrozen(parsed.assignments[0].execution));
  source.assignments[0].prompt = 'mutated after validation';
  assert.equal(parsed.assignments[0].prompt, 'Implement the bounded change.');
  assert.throws(() => { parsed.assignments.push(writer('other', ['other/**'])); }, TypeError);
});

test('repository paths reject lone surrogates, bidi controls, and non-NFC segments', () => {
  for (const path of ['/repos/\ud800', '/repos/\u202eevil', '/repos/e\u0301']) {
    const error = violation((manifest) => { manifest.repository.path = path; });
    assert.equal(error.code, 'invalid_format');
    assert.equal(error.path, 'repository.path');
  }
});

test('errors are bounded and do not echo attacker-controlled identifier content', () => {
  const marker = `secret-${'x'.repeat(1000)}`;
  const error = violation((manifest) => { manifest.run_id = marker; });
  assert.equal(error.code, 'invalid_format');
  assert.ok(error.message.length < 256);
  assert.equal(error.message.includes(marker), false);
});

test('oversized object keys are rejected before entering paths or messages', () => {
  const rootKey = `root-secret-${'r'.repeat(1_000_000)}`;
  const rootError = violation((manifest) => { manifest[rootKey] = true; });
  assert.equal(rootError.code, 'manifest_too_large');
  assert.equal(rootError.path, '$');
  assert.ok(rootError.message.length < 256);
  assert.equal(rootError.message.includes('root-secret'), false);

  const parameterKey = `parameter-secret-${'p'.repeat(300_000)}`;
  const parameterError = violation((manifest) => {
    manifest.assignments[0].acceptance[0].parameters = { [parameterKey]: 'value' };
  });
  assert.equal(parameterError.code, 'manifest_too_large');
  assert.equal(parameterError.path, '$.assignments[0].acceptance[0].parameters');
  assert.ok(parameterError.message.length < 256);
  assert.equal(parameterError.message.includes('parameter-secret'), false);
});

test('object-key bytes contribute to the aggregate manifest string budget', () => {
  const manifest = validRun();
  manifest.padding = Array.from({ length: 600 }, (_, index) => ({
    [`${String(index).padStart(4, '0')}${'k'.repeat(MAX_MANIFEST_KEY_BYTES - 4)}`]: 0,
  }));
  manifest.objective = 'x'.repeat(MAX_MANIFEST_TOTAL_STRING_BYTES - 75_000);
  assert.throws(
    () => validateRunManifestV1(manifest),
    (error) => error instanceof RunContractV1Error && error.code === 'manifest_too_large',
  );
});

test('each scope segment enforces the exported byte limit', () => {
  const error = violation((manifest) => {
    manifest.assignments[0].write_scope = [`${'s'.repeat(SCOPE_SEGMENT_MAX_BYTES + 1)}/**`];
  });
  assert.equal(error.code, 'out_of_range');
  assert.equal(error.path, 'assignments[0].write_scope[0]');
  assert.match(error.message, new RegExp(String(SCOPE_SEGMENT_MAX_BYTES), 'u'));
});

test('the maximum legal lane, scope, command, and parameter cross-product fits the total budget', () => {
  const manifest = validRun();
  manifest.policy.max_concurrency = MAX_ASSIGNMENTS;
  manifest.assignments = Array.from({ length: MAX_ASSIGNMENTS }, (_, lane) => {
    const assignment = writer(`lane-${lane}`, Array.from(
      { length: 16 },
      (_, scope) => `lane${lane}/path-${scope}-${'s'.repeat(96)}/**`,
    ));
    assignment.prompt = 'p'.repeat(PROMPT_MAX_BYTES);
    assignment.acceptance = Array.from({ length: ACCEPTANCE_MAX_COMMANDS }, (_, command) => ({
      command_id: `command-${command}`,
      timeout_ms: MAX_TIMEOUT_MS,
      parameters: Object.fromEntries(Array.from(
        { length: PARAMS_MAX_KEYS },
        (_, parameter) => [`p${parameter}`, 'v'.repeat(PARAM_VALUE_MAX_BYTES)],
      )),
    }));
    assignment.required_evidence = [
      'provider_report', 'git_identity', 'git_diff', 'acceptance_results',
    ];
    return assignment;
  });
  const summary = validateRunManifestV1(manifest);
  assert.equal(summary.assignment_count, MAX_ASSIGNMENTS);
});

test('manifest complexity, cycles, aliases, and policy authority keys fail before dispatch', () => {
  const tooManyNodes = violation((manifest) => {
    manifest.assignments[0].note = Array.from({ length: MAX_MANIFEST_NODES + 1 }, () => 0);
  });
  assert.equal(tooManyNodes.code, 'manifest_too_complex');

  const cyclic = validRun();
  cyclic.assignments[0].loop = cyclic.assignments[0];
  assert.throws(() => validateRunManifestV1(cyclic), (error) => error.code === 'invalid_json_value');

  const aliased = validRun();
  aliased.assignments.push(writer('lane-1', ['other/**']));
  aliased.assignments[1].execution = aliased.assignments[0].execution;
  assert.throws(() => validateRunManifestV1(aliased), (error) => error.code === 'invalid_json_value');

  for (const [key, value, code] of [
    ['allow_merge', false, 'merge_authority_denied'],
    ['allow_create_pr', false, 'merge_authority_denied'],
    ['allow_post_dispatch_fallback', false, 'replay_or_fallback_denied'],
  ]) {
    const denied = violation((manifest) => { manifest[key] = value; });
    assert.equal(denied.code, code);
    assert.equal(denied.path, `$.${key}`);
  }
});

test('empty approved-command scalar parameters are valid bounded data', () => {
  const manifest = validRun();
  manifest.assignments[0].acceptance[0].parameters = { optional_filter: '' };
  validateRunManifestV1(manifest);
});
