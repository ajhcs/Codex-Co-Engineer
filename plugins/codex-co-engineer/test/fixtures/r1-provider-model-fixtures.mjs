// Shared P04 provider/model/role grammar fixtures.
//
// One fixture module feeds both sides of the grammar contract: ProfileV1
// validation and AssignmentManifestV1 execution validation. The fixtures are
// intentionally neutral shared test data - the production profile module
// imports no run-manifest module, so parity is proven here, in test code,
// against the same accepted and hostile corpora on every provider.
//
// A model identifier is bounded REQUESTED BYTES only: ProfileV1 checks syntax
// and size and never enforces membership against any advertised list, so the
// accepted corpora deliberately mix advertised names with names that no
// provider currently lists. Both sides of the contract accept and reject the
// SAME corpus: a model identifier is an opaque identifier - never a path, ref,
// command, or credential - so grammar-valid identifiers keep their meaning
// (`a..b`, `x/../escape`, `main`, `refs/heads/model`, `cmd:model`,
// `sk-abcdefghijklmnop`) and neither side applies any extra profile-only or
// assignment-only clause to the top-level model value.

export const PROFILE_SCHEMA = 'codex-co-engineer.profile.v1';

// Every exact provider route with grammar-valid model selections. Names after
// the first two per provider are deliberately unadvertised: acceptance must
// not depend on any membership list.
export const PROVIDER_MODEL_FIXTURES = Object.freeze([
  Object.freeze({
    provider: 'dsh',
    models: Object.freeze([
      'muse-spark-1.2-contributor',
      'stealth/ox-alpha',
      'future-dsh-model',
      'unlisted-future/model.9',
    ]),
  }),
  Object.freeze({
    provider: 'grok',
    models: Object.freeze(['grok-4', 'grok-code-fast-1', 'unlisted-grok/model.9']),
  }),
  Object.freeze({
    provider: 'cursor-local',
    models: Object.freeze(['composer-1', 'cursor_smoke_model', 'unlisted-local/model.9']),
  }),
  Object.freeze({
    provider: 'cursor-cloud',
    models: Object.freeze(['claude-sonnet-4-5', 'gpt-5.1-codex', 'unlisted-cloud/model.9']),
  }),
]);

// Hostile model corpus. Every entry is rejected IDENTICALLY by both sides of
// the contract, and `impliedBy` documents the single shared-grammar predicate
// that explains the rejection:
// - `pattern`: fails `^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$` (bad first
//   character, a character outside the class, or more than 128 characters).
// There is no second clause: neither side carries an extra profile-only or
// assignment-only guard (such as a '..' traversal rule), so the shared grammar
// alone explains every rejection on both sides.
//
// The `bytes` predicate (pattern-valid but over 128 requested bytes) can never
// fire on its own: the character class is ASCII-only, so every pattern-valid
// identifier is at most 128 characters and therefore at most 128 UTF-8 bytes.
// The requested-byte bound is retained on both sides - and exercised at its
// exact 128-byte boundary in BOUNDARY_ACCEPTED_MODELS below - as mirrored
// defense in depth.
export const HOSTILE_MODEL_CORPUS = Object.freeze([
  // Pattern: first character.
  Object.freeze({ model: '', impliedBy: 'pattern' }),
  Object.freeze({ model: '.hidden', impliedBy: 'pattern' }),
  Object.freeze({ model: '-leading-hyphen', impliedBy: 'pattern' }),
  Object.freeze({ model: '_leading-underscore', impliedBy: 'pattern' }),
  Object.freeze({ model: '/leading-slash', impliedBy: 'pattern' }),
  Object.freeze({ model: ':leading-colon', impliedBy: 'pattern' }),
  // Pattern: characters outside the ASCII class.
  Object.freeze({ model: 'has space', impliedBy: 'pattern' }),
  Object.freeze({ model: 'back\\slash', impliedBy: 'pattern' }),
  Object.freeze({ model: 'tab\tchar', impliedBy: 'pattern' }),
  Object.freeze({ model: 'newline\nchar', impliedBy: 'pattern' }),
  Object.freeze({ model: 'uni\u00e9code', impliedBy: 'pattern' }),
  Object.freeze({ model: 'emoji\u{1F600}model', impliedBy: 'pattern' }),
  Object.freeze({ model: 'wild*card', impliedBy: 'pattern' }),
  Object.freeze({ model: 'query?param', impliedBy: 'pattern' }),
  Object.freeze({ model: 'bracke[t]s', impliedBy: 'pattern' }),
  // Pattern: more than 128 characters (also past the 128-byte bound).
  Object.freeze({ model: `${'q_'.repeat(64)}q`, impliedBy: 'pattern' }),
  Object.freeze({ model: `${'q'.repeat(42)}.${'q'.repeat(43)}.${'q'.repeat(42)}`, impliedBy: 'pattern' }),
  Object.freeze({ model: `${'a_'.repeat(64)}x`, impliedBy: 'pattern' }),
  Object.freeze({ model: `\u00e9${'a'.repeat(127)}`, impliedBy: 'pattern' }),
  Object.freeze({ model: '\u00e9'.repeat(65), impliedBy: 'pattern' }),
]);

// Shared accepted corpus of opaque identifiers: every entry is
// grammar-valid and therefore accepted IDENTICALLY by ProfileV1 and by
// AssignmentManifestV1 execution validation. The shapes are deliberately
// hostile-looking - dot segments, ref-like prefixes, command-like prefixes,
// credential-like prefixes - to prove that neither side applies any semantic
// value scan or extra guard to the top-level model identifier: model IDs are
// opaque identifiers, not paths, refs, commands, or credentials.
export const PARITY_ACCEPTED_MODELS = Object.freeze([
  Object.freeze({ model: 'a..b' }),
  Object.freeze({ model: 'x/../escape' }),
  Object.freeze({ model: 'stealth/../../ox' }),
  Object.freeze({ model: 'main' }),
  Object.freeze({ model: 'origin/model' }),
  Object.freeze({ model: 'refs/heads/model' }),
  Object.freeze({ model: 'cmd:model' }),
  Object.freeze({ model: 'zsh/model' }),
  Object.freeze({ model: 'sk-abcdefghijklmnop' }),
  Object.freeze({ model: 'vendor_x/model.07:build' }),
]);

// Exact grammar boundary strings that must be accepted on every provider and
// on the assignment side: one identifier exactly on the 128-character/128-byte
// bound, one just under it, and one exercising every special class member.
export const BOUNDARY_ACCEPTED_MODELS = Object.freeze([
  // Exactly 128 characters = exactly 128 UTF-8 bytes: the inclusive bound.
  `${'z'.repeat(64)}.${'z'.repeat(63)}`,
  // 127 characters: one under the bound.
  `${'z'.repeat(31)}.${'z'.repeat(31)}.${'z'.repeat(31)}.${'z'.repeat(31)}`,
  'A9._-:/x',
]);

export const PROFILE_ROLE_FIXTURES = Object.freeze(['review', 'implement', 'verify']);

// A minimal AssignmentManifestV1 lane executing an explicit provider/model
// pair, used to prove the same fixtures behave identically on the assignment
// side of the contract.
// Exact already-pushed provider-visible SHA for Cloud lanes under the
// AssignmentManifestV1 pinning rule.
export const CLOUD_STARTING_REF = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

export function assignmentExecutionFixture(provider, model, overrides = {}) {
  const base = {
    assignment_id: 'grammar-probe',
    role: 'implement',
    access: 'writer',
    prompt: 'Probe the shared bounded model grammar.',
    execution: { provider, model },
    write_scope: ['src/**'],
    acceptance: [],
    expected_duration_ms: 600_000,
    required_evidence: ['provider_report'],
  };
  // Run Cloud lanes must pin one exact SHA; local lanes must not carry one.
  if (provider === 'cursor-cloud') base.starting_ref = CLOUD_STARTING_REF;
  return Object.freeze({ ...base, ...overrides });
}

// A minimal read-only verify lane: the role the profile vocabulary gains.
export function verifyAssignmentFixture(provider, model) {
  return assignmentExecutionFixture(provider, model, {
    assignment_id: 'verify-probe',
    role: 'verify',
    access: 'read_only',
    write_scope: [],
    required_evidence: ['provider_report', 'git_identity'],
  });
}

export function profileDefinitionFixture(overrides = {}) {
  return Object.freeze({
    schema: PROFILE_SCHEMA,
    provider: 'dsh',
    role: 'implement',
    expected_duration_ms: 600_000,
    ...overrides,
  });
}
