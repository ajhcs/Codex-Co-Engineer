// ChildEnvelopeV1 — deterministic prompt compiler for bounded 3.3.0 runs
// (P03; ADR 0001 identifiers `exact_identities`, `bounded_evidence`,
// `disjoint_writer_scopes`, `no_post_dispatch_fallback_or_replay`).
//
// Additive v3 module. It compiles ONE child work envelope per assignment out
// of an already-validated RunManifestV1 and edits no existing runtime
// surface. Guarantees, each enforced at runtime:
//
//   - Deterministic: the envelope is a pure function of the canonical,
//     deeply frozen manifest snapshot returned by parseRunManifestV1().
//     Identical manifests render byte-identical UTF-8 text; JSON key order
//     in the caller's object cannot leak into the rendering.
//   - Isolated: an envelope embeds its own lane's objective and prompt as
//     opaque, byte-counted blocks plus run-level facts only. Sibling
//     prompts, results, IDs, and provider choices are never rendered, and
//     the compiler adds no routing, model-selection, fallback, or replay
//     instructions of its own.
//   - Bounded: MAX_ENVELOPE_BYTES is an exact worst-case bound derived from
//     the P02 manifest limits; a rendered envelope larger than the bound is
//     rejected instead of truncated.
//   - Verified: every compiled envelope must round-trip through the strict
//     byte-exact parser below before it is returned (fail closed).
//
// User prompt content is opaque data. It is never trimmed, re-wrapped,
// Unicode-normalized, or interpreted. Framing carries exact UTF-8 byte
// counts, so consumers extract the original bytes by count rather than by
// scanning for end markers: a prompt may safely contain framing look-alikes.

import {
  ACCEPTANCE_MAX_COMMANDS,
  ASSIGNMENT_ID_MAX,
  ASSIGNMENT_ID_PATTERN,
  COMMAND_ID_MAX,
  COMMAND_ID_PATTERN,
  EVIDENCE_KINDS,
  MAX_ASSIGNMENTS,
  MAX_TIMEOUT_MS,
  MIN_ASSIGNMENTS,
  MIN_TIMEOUT_MS,
  MODEL_ID_MAX,
  MODEL_ID_PATTERN,
  OBJECTIVE_MAX_BYTES,
  OBJECTIVE_MIN_BYTES,
  PARAM_KEY_PATTERN,
  PARAM_VALUE_MAX_BYTES,
  PARAMS_MAX_KEYS,
  PROFILE_NAME_MAX,
  PROFILE_NAME_PATTERN,
  PROMPT_MAX_BYTES,
  PROMPT_MIN_BYTES,
  PROVIDERS,
  ROLE_ACCESS,
  RUN_ID_MAX,
  RunContractV1Error,
  SCOPE_MAX_PATTERNS,
  SCOPE_PATTERN_MAX_BYTES,
  SHA40_PATTERN,
  assertBaseSha,
  assertBoundedText,
  assertJsonDataObject,
  assertRepositoryPath,
  assertRunId,
  assertTimeoutMs,
  assertWriteScopePatterns,
  isPlainObject,
  utf8ByteLength,
} from './run-manifest.mjs';
import { parseRunManifestV1 } from './run-policy.mjs';

export const CHILD_ENVELOPE_SCHEMA_ID = 'codex-co-engineer.child-envelope.v1';
export const CHILD_ENVELOPE_VERSION = 1;

// Worst-case rendering bounds. They mirror the P02 validators so the cap can
// never reject a manifest those validators accept. JSON string escaping can
// expand one parameter value to at most 3x its UTF-8 byte length (one astral
// code point encodes as 4 UTF-8 bytes but escapes as two \uXXXX sequences).
const ENVELOPE_SCAFFOLD_RESERVE_BYTES = 1024;
const ENVELOPE_FRAME_OVERHEAD_BYTES = 64;
const ENVELOPE_LINE_OVERHEAD_BYTES = 48;
const ENVELOPE_TIMEOUT_LINE_BYTES = 32;
const ENVELOPE_EVIDENCE_LINE_BYTES = 32;
const REPOSITORY_PATH_MAX_BYTES = 4096; // matches assertRepositoryPath()
const PARAM_KEY_MAX_BYTES = 32; // matches PARAM_KEY_PATTERN grammar bound
const JSON_ESCAPE_MAX_EXPANSION_FACTOR = 3;

export const MAX_ENVELOPE_BYTES =
  ENVELOPE_SCAFFOLD_RESERVE_BYTES
  + RUN_ID_MAX + ASSIGNMENT_ID_MAX + MODEL_ID_MAX + PROFILE_NAME_MAX
  + 2 * (SHA40_PATTERN.source.length + ENVELOPE_LINE_OVERHEAD_BYTES)
  + REPOSITORY_PATH_MAX_BYTES + ENVELOPE_LINE_OVERHEAD_BYTES
  + OBJECTIVE_MAX_BYTES + ENVELOPE_FRAME_OVERHEAD_BYTES
  + PROMPT_MAX_BYTES + ENVELOPE_FRAME_OVERHEAD_BYTES
  + SCOPE_MAX_PATTERNS * (SCOPE_PATTERN_MAX_BYTES + ENVELOPE_LINE_OVERHEAD_BYTES)
  + ACCEPTANCE_MAX_COMMANDS * (
    COMMAND_ID_MAX + ENVELOPE_TIMEOUT_LINE_BYTES + ENVELOPE_LINE_OVERHEAD_BYTES
    + PARAMS_MAX_KEYS * (
      PARAM_KEY_MAX_BYTES + ENVELOPE_LINE_OVERHEAD_BYTES
      + PARAM_VALUE_MAX_BYTES * JSON_ESCAPE_MAX_EXPANSION_FACTOR))
  + EVIDENCE_KINDS.length * (ENVELOPE_EVIDENCE_LINE_BYTES + ENVELOPE_LINE_OVERHEAD_BYTES);

function fail(code, path, message) {
  throw new RunContractV1Error(code, path, message);
}

function truncateForMessage(value) {
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function deepFreezeJson(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreezeJson(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function deepEqualJson(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length
      && a.every((entry, index) => deepEqualJson(entry, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]));
  }
  return false;
}

function wellFormedUtf8(bytes, path) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail('invalid_format', path, `${path} is not well-formed UTF-8.`);
  }
  return text;
}

function decimalInt(value, path, { min, max }) {
  if (!/^[0-9]{1,10}$/u.test(value)) {
    fail('invalid_format', path, `${path} must be a non-negative decimal integer.`);
  }
  const parsed = Number(value);
  if (String(parsed) !== value) {
    fail('invalid_format', path,
      `${path} must use the compiler's canonical decimal encoding without leading zeroes.`);
  }
  if (parsed < min || parsed > max) {
    fail('out_of_range', path, `${path} is ${parsed}; allowed range is ${min}..${max}.`);
  }
  return parsed;
}

function sortedParameters(parameters, path) {
  const sorted = {};
  for (const key of Object.keys(parameters).sort()) {
    if (!PARAM_KEY_PATTERN.test(key)) {
      fail('invalid_format', `${path}.${key}`, `${path}.${key} violates the parameter-key grammar.`);
    }
    // JSON's canonical numeric spelling maps negative zero to zero. Keep the
    // structured compiler output in that same canonical domain so the object
    // returned by compile, its rendered bytes, the strict parser result, and
    // the identity digest are exact inverses rather than merely digest-equal.
    sorted[key] = Object.is(parameters[key], -0) ? 0 : parameters[key];
  }
  return sorted;
}

function buildLaneFields(snapshot, index) {
  const assignment = snapshot.assignments[index];
  const execution = assignment.execution;
  return {
    schema: CHILD_ENVELOPE_SCHEMA_ID,
    version: CHILD_ENVELOPE_VERSION,
    run_id: snapshot.run_id,
    lane_index: index,
    assignment_count: snapshot.assignments.length,
    repository: Object.freeze({
      path: snapshot.repository.path,
      base_sha: snapshot.repository.base_sha,
    }),
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    access: assignment.access,
    execution: Object.freeze({
      provider: Object.hasOwn(execution, 'provider') ? execution.provider : null,
      model: Object.hasOwn(execution, 'model') ? execution.model : null,
      profile: Object.hasOwn(execution, 'profile') ? execution.profile : null,
    }),
    starting_ref: Object.hasOwn(assignment, 'starting_ref') ? assignment.starting_ref : null,
    write_scope: Object.freeze([...assignment.write_scope]),
    acceptance: Object.freeze(assignment.acceptance.map((entry) => Object.freeze({
      command_id: entry.command_id,
      timeout_ms: entry.timeout_ms,
      parameters: deepFreezeJson(sortedParameters(
        Object.hasOwn(entry, 'parameters') ? entry.parameters : {},
        `assignments[${index}].acceptance[${entry.command_id}].parameters`,
      )),
    }))),
    required_evidence: Object.freeze([...assignment.required_evidence]),
    objective: snapshot.objective,
    prompt: assignment.prompt,
  };
}

function renderEnvelope(fields) {
  const parts = [];
  const framedBlocks = {};
  let cursor = 0;
  const pushLine = (text) => {
    parts.push(text, '\n');
    cursor += utf8ByteLength(text) + 1;
  };
  const pushBlock = (name, content) => {
    const contentBytes = utf8ByteLength(content);
    pushLine(`begin-${name} ${contentBytes} bytes`);
    framedBlocks[name] = Object.freeze({ byte_offset: cursor, byte_length: contentBytes });
    parts.push(content, '\n');
    cursor += contentBytes + 1;
    pushLine(`end-${name}`);
  };

  pushLine(`schema: ${fields.schema}`);
  pushLine(`version: ${fields.version}`);
  pushLine(`run_id: ${fields.run_id}`);
  pushLine(`lane_index: ${fields.lane_index}`);
  pushLine(`assignment_count: ${fields.assignment_count}`);
  pushLine(`repository_path: ${fields.repository.path}`);
  pushLine(`base_sha: ${fields.repository.base_sha}`);
  pushBlock('objective', fields.objective);
  pushLine(`assignment_id: ${fields.assignment_id}`);
  pushLine(`role: ${fields.role}`);
  pushLine(`access: ${fields.access}`);
  pushLine(`execution.provider: ${fields.execution.provider ?? '-'}`);
  pushLine(`execution.model: ${fields.execution.model ?? '-'}`);
  pushLine(`execution.profile: ${fields.execution.profile ?? '-'}`);
  pushLine(`starting_ref: ${fields.starting_ref ?? '-'}`);
  pushLine(`write_scope.count: ${fields.write_scope.length}`);
  fields.write_scope.forEach((pattern, index) => pushLine(`write_scope[${index}]: ${pattern}`));
  pushLine(`acceptance.count: ${fields.acceptance.length}`);
  fields.acceptance.forEach((entry, index) => {
    const prefix = `acceptance[${index}]`;
    pushLine(`${prefix}.command_id: ${entry.command_id}`);
    pushLine(`${prefix}.timeout_ms: ${entry.timeout_ms}`);
    const keys = Object.keys(entry.parameters);
    pushLine(`${prefix}.parameter.count: ${keys.length}`);
    for (const key of keys) {
      pushLine(`${prefix}.parameter.${key}: ${JSON.stringify(entry.parameters[key])}`);
    }
  });
  pushLine(`required_evidence.count: ${fields.required_evidence.length}`);
  fields.required_evidence.forEach((kind, index) => pushLine(`required_evidence[${index}]: ${kind}`));
  pushBlock('prompt', fields.prompt);

  return Object.freeze({
    text: parts.join(''),
    byte_length: cursor,
    framed_blocks: Object.freeze(framedBlocks),
  });
}

function resolveLaneIndex(assignments, selection) {
  if (typeof selection === 'number') {
    if (!Number.isInteger(selection) || selection < 0 || selection >= assignments.length) {
      fail('assignment_index_out_of_range', 'assignments',
        `assignment index must be an integer within 0..${assignments.length - 1}; received ${selection}.`);
    }
    return selection === 0 ? 0 : selection;
  }
  if (typeof selection === 'string') {
    const index = assignments.findIndex((assignment) => assignment.assignment_id === selection);
    if (index === -1) {
      fail('unknown_assignment_id', 'assignments',
        `No assignment "${truncateForMessage(selection)}" is declared by this run.`);
    }
    return index;
  }
  fail('invalid_type', 'assignments', 'Select a child envelope by exact assignment_id string or lane index integer.');
}

function compileFromSnapshot(snapshot, index) {
  const fields = buildLaneFields(snapshot, index);
  const rendered = renderEnvelope(fields);
  if (rendered.byte_length > MAX_ENVELOPE_BYTES) {
    fail('envelope_too_large', `assignments[${index}]`,
      `Compiled child envelope is ${rendered.byte_length} bytes; maximum is ${MAX_ENVELOPE_BYTES}.`);
  }
  const envelope = deepFreezeJson({
    ...fields,
    framed_blocks: rendered.framed_blocks,
    envelope_byte_length: rendered.byte_length,
    envelope_text: rendered.text,
  });
  const reparsed = parseChildEnvelopeV1(rendered.text);
  if (!deepEqualJson(reparsed, envelope)) {
    fail('envelope_round_trip', `assignments[${index}]`,
      `Compiled envelope for "${envelope.assignment_id}" failed strict re-parse verification.`);
  }
  return envelope;
}

// Compile one deterministic child envelope. `manifest` may be a raw manifest
// or an already-parsed frozen snapshot; it is always re-validated through
// parseRunManifestV1() so digest-grade inputs cannot bypass the contract.
export function compileChildEnvelopeV1(manifest, selection) {
  const snapshot = parseRunManifestV1(manifest);
  const index = resolveLaneIndex(snapshot.assignments, selection);
  return compileFromSnapshot(snapshot, index);
}

// Compile every child envelope in manifest order with one validation pass.
export function compileChildEnvelopesV1(manifest) {
  const snapshot = parseRunManifestV1(manifest);
  const envelopes = [];
  for (let index = 0; index < snapshot.assignments.length; index += 1) {
    envelopes.push(compileFromSnapshot(snapshot, index));
  }
  return Object.freeze(envelopes);
}

// Elide framed opaque blocks so reviewers and tests can audit the exact
// static scaffold a worker sees. Caller-supplied ranges are never trusted:
// the envelope is parsed first and the supplied framedBlocks must exactly
// equal the parser's closed objective/prompt framing (same ranges, no extra
// or missing entries, no extra fields) before any offset is used. Elision
// then cuts on those validated byte offsets, so multi-byte content can never
// split the surrounding scaffold and forged offsets cannot reposition the
// elision window over scaffold lines.
export function envelopeRoutingSurfaceV1(envelopeText, framedBlocks) {
  if (typeof envelopeText !== 'string' || !isPlainObject(framedBlocks)) {
    fail('invalid_type', 'envelope', 'Routing-surface elision requires envelope text and framed block offsets.');
  }
  // The exact-shape contract is closed at the direct-JavaScript boundary as
  // well: every own key of the supplied framing must be an enumerable string
  // data property on a plain object. Non-enumerable or symbol extra own keys
  // and accessor properties are invisible to deepEqualJson()'s Object.keys
  // view, so they are rejected here before any offset is trusted.
  const rootEntries = assertJsonDataObject(framedBlocks, 'envelope.framed_blocks');
  const rootValues = new Map(rootEntries.map(({ key, value }) => [key, value]));
  const objectiveFrame = rootValues.get('objective');
  const promptFrame = rootValues.get('prompt');
  if (!isPlainObject(objectiveFrame) || !isPlainObject(promptFrame)) {
    fail('invalid_type', 'envelope', 'Routing-surface elision requires envelope text and framed block offsets.');
  }
  assertJsonDataObject(objectiveFrame, 'envelope.framed_blocks.objective');
  assertJsonDataObject(promptFrame, 'envelope.framed_blocks.prompt');
  const parsed = parseChildEnvelopeV1(envelopeText);
  if (!deepEqualJson(framedBlocks, parsed.framed_blocks)) {
    fail('framed_blocks_mismatch', 'envelope.framed_blocks',
      'Supplied framed blocks do not exactly equal the parsed objective/prompt framing of this envelope.');
  }
  const bytes = Buffer.from(envelopeText, 'utf8');
  const segments = [];
  let cursor = 0;
  for (const name of ['objective', 'prompt']) {
    const { byte_offset: byteOffset, byte_length: byteLength } = parsed.framed_blocks[name];
    segments.push(wellFormedUtf8(bytes.subarray(cursor, byteOffset), 'envelope'));
    segments.push(`<${name} ${byteLength} bytes elided>\n`);
    cursor = byteOffset + byteLength + 1;
  }
  segments.push(wellFormedUtf8(bytes.subarray(cursor), 'envelope'));
  return segments.join('');
}

const ENVELOPE_KEY_PATTERN = /^[a-z0-9][a-z0-9.\[\]_-]*$/u;
const ENVELOPE_BLOCK_HEADER_PATTERN = /^begin-([a-z][a-z-]*) ([0-9]{1,7}) bytes$/u;

function createReader(envelopeText) {
  assertBoundedText(envelopeText, {
    min: 1,
    max: MAX_ENVELOPE_BYTES,
    path: 'envelope',
    label: 'envelope',
    allowBlank: true,
  });
  const bytes = Buffer.from(envelopeText, 'utf8');
  return { bytes, offset: 0 };
}

function readScaffoldLine(reader) {
  const newline = reader.bytes.indexOf(0x0a, reader.offset);
  if (newline === -1) {
    fail('envelope_truncated', 'envelope', 'Envelope ends inside a scaffold line.');
  }
  const raw = reader.bytes.subarray(reader.offset, newline);
  reader.offset = newline + 1;
  return wellFormedUtf8(raw, 'envelope');
}

function splitScaffoldLine(lineText) {
  const separator = lineText.indexOf(': ');
  if (separator === -1) {
    fail('malformed_envelope', 'envelope',
      `Envelope line "${truncateForMessage(lineText)}" is not "key: value".`);
  }
  const key = lineText.slice(0, separator);
  if (!ENVELOPE_KEY_PATTERN.test(key)) {
    fail('unknown_envelope_line', 'envelope', `Envelope key "${truncateForMessage(key)}" is not part of the template.`);
  }
  return { key, value: lineText.slice(separator + 2) };
}

function expectLine(reader, key) {
  const parsed = splitScaffoldLine(readScaffoldLine(reader));
  if (parsed.key !== key) {
    fail('malformed_envelope', `envelope.${key}`,
      `Expected envelope line "${key}: ...", found "${truncateForMessage(parsed.key)}: ...".`);
  }
  return parsed.value;
}

function expectBlock(reader, name, path) {
  const header = readScaffoldLine(reader);
  const match = ENVELOPE_BLOCK_HEADER_PATTERN.exec(header);
  if (!match || match[1] !== name) {
    fail('malformed_envelope', path,
      `Expected "begin-${name} <n> bytes", found "${truncateForMessage(header)}".`);
  }
  const byteLength = Number(match[2]);
  if (String(byteLength) !== match[2]) {
    fail('invalid_format', path,
      `Framed block "${name}" must use the compiler's canonical decimal byte length.`);
  }
  const contentStart = reader.offset;
  const contentEnd = contentStart + byteLength;
  if (contentEnd >= reader.bytes.length || reader.bytes[contentEnd] !== 0x0a) {
    fail('envelope_truncated', path,
      `Framed block "${name}" does not end at its declared ${byteLength}-byte boundary.`);
  }
  const footerStart = contentEnd + 1;
  const footer = `end-${name}`;
  if (footerStart + footer.length > reader.bytes.length
    || reader.bytes.subarray(footerStart, footerStart + footer.length).toString('latin1') !== footer) {
    fail('malformed_envelope', path, `Framed block "${name}" lacks its end marker.`);
  }
  reader.offset = footerStart + footer.length;
  // The end marker must be terminated by exactly one newline. For the final
  // "end-prompt" this is the envelope's terminal byte: combined with the
  // trailing-content check in parseChildEnvelopeV1(), an envelope may neither
  // omit that newline nor carry any extra terminal byte after it.
  if (reader.bytes[reader.offset] !== 0x0a) {
    fail('malformed_envelope', path,
      `"end-${name}" must terminate its own line with exactly one terminal newline.`);
  }
  reader.offset += 1;
  return Object.freeze({
    content: wellFormedUtf8(reader.bytes.subarray(contentStart, contentEnd), path),
    byte_offset: contentStart,
    byte_length: byteLength,
  });
}

function expectPatternedValue(value, pattern, maxBytes, path, label) {
  if (typeof value !== 'string' || !pattern.test(value) || utf8ByteLength(value) > maxBytes) {
    fail('invalid_format', path, `${label} violates the required grammar ${String(pattern)}.`);
  }
  return value;
}

function parseJsonScalar(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_format', path, `${path} must be one JSON scalar encoded on a single line.`);
  }
  if (typeof parsed === 'string') {
    assertBoundedText(parsed, {
      min: 0, max: PARAM_VALUE_MAX_BYTES, path, label: path, allowBlank: true,
    });
    if (JSON.stringify(parsed) !== text) {
      fail('invalid_format', path, `${path} is not the canonical single-line JSON encoding of its value.`);
    }
    return parsed;
  }
  if (typeof parsed === 'number') {
    if (!Number.isSafeInteger(parsed) || String(parsed) !== text) {
      fail('invalid_format', path, `${path} numeric parameters must be canonical safe integers.`);
    }
    return parsed;
  }
  if (typeof parsed === 'boolean') {
    if ((parsed === true) !== (text === 'true')) {
      fail('invalid_format', path, `${path} boolean parameters must encode as exactly true or false.`);
    }
    return parsed;
  }
  fail('invalid_type', path, `${path} parameters must be flat scalars (string, integer, boolean).`);
}

// Strict byte-exact inverse of the renderer. Consumers must parse envelopes
// through this function instead of scanning text: framing look-alikes inside
// opaque content can never redirect it. Throws RunContractV1Error on any
// deviation from the template, ordering, grammars, or declared byte counts.
export function parseChildEnvelopeV1(envelopeText) {
  const reader = createReader(envelopeText);
  const schema = expectLine(reader, 'schema');
  if (schema !== CHILD_ENVELOPE_SCHEMA_ID) {
    fail('invalid_format', 'envelope.schema', `Envelope schema must be exactly "${CHILD_ENVELOPE_SCHEMA_ID}".`);
  }
  const version = decimalInt(expectLine(reader, 'version'), 'envelope.version', { min: 1, max: CHILD_ENVELOPE_VERSION });
  if (version !== CHILD_ENVELOPE_VERSION) {
    fail('invalid_format', 'envelope.version', `Envelope version must be exactly ${CHILD_ENVELOPE_VERSION}.`);
  }
  const runId = expectLine(reader, 'run_id');
  assertRunId(runId, 'envelope.run_id');
  const laneIndex = decimalInt(expectLine(reader, 'lane_index'), 'envelope.lane_index', { min: 0, max: MAX_ASSIGNMENTS - 1 });
  const assignmentCount = decimalInt(expectLine(reader, 'assignment_count'), 'envelope.assignment_count', { min: MIN_ASSIGNMENTS, max: MAX_ASSIGNMENTS });
  if (laneIndex >= assignmentCount) {
    fail('invalid_format', 'envelope.lane_index', `lane_index ${laneIndex} is not below assignment_count ${assignmentCount}.`);
  }
  const repositoryPath = expectLine(reader, 'repository_path');
  assertRepositoryPath(repositoryPath, 'envelope.repository_path');
  const baseSha = expectLine(reader, 'base_sha');
  assertBaseSha(baseSha, 'envelope.base_sha');
  const objectiveBlock = expectBlock(reader, 'objective', 'envelope.objective');
  assertBoundedText(objectiveBlock.content, {
    min: OBJECTIVE_MIN_BYTES, max: OBJECTIVE_MAX_BYTES, path: 'envelope.objective', label: 'objective',
  });
  const assignmentId = expectPatternedValue(
    expectLine(reader, 'assignment_id'), ASSIGNMENT_ID_PATTERN, ASSIGNMENT_ID_MAX, 'envelope.assignment_id', 'assignment_id',
  );
  const role = expectLine(reader, 'role');
  if (!ROLE_ACCESS[role]) {
    fail('unknown_role', 'envelope.role', `Envelope role "${truncateForMessage(role)}" is not a declared assignment role.`);
  }
  const access = expectLine(reader, 'access');
  if (access !== 'writer' && access !== 'read_only') {
    fail('unknown_access', 'envelope.access', 'Envelope access must be "writer" or "read_only".');
  }
  if (ROLE_ACCESS[role] !== access) {
    fail('role_access_mismatch', 'envelope.access', `Envelope role "${role}" requires access "${ROLE_ACCESS[role]}".`);
  }

  const providerRaw = expectLine(reader, 'execution.provider');
  if (providerRaw !== '-' && !PROVIDERS.includes(providerRaw)) {
    fail('unknown_provider', 'envelope.execution.provider', `execution.provider must be "-" or one of ${PROVIDERS.join(', ')}.`);
  }
  const modelRaw = expectLine(reader, 'execution.model');
  if (modelRaw !== '-') {
    expectPatternedValue(modelRaw, MODEL_ID_PATTERN, MODEL_ID_MAX, 'envelope.execution.model', 'execution.model');
  }
  const profileRaw = expectLine(reader, 'execution.profile');
  if (profileRaw !== '-') {
    expectPatternedValue(profileRaw, PROFILE_NAME_PATTERN, PROFILE_NAME_MAX, 'envelope.execution.profile', 'execution.profile');
  }
  // The three execution lines must encode exactly one compiler-emittable
  // semantic state, and every non-"-" routing value must survive into the
  // parsed form: either an explicit provider + model pair (profile "-") or
  // one named profile (provider AND model both "-"). Anything else is
  // rejected instead of silently discarding a routing value.
  const hasExplicit = providerRaw !== '-';
  const hasModel = modelRaw !== '-';
  const hasProfile = profileRaw !== '-';
  if (hasExplicit === hasProfile) {
    fail('execution_ambiguous', 'envelope.execution.provider',
      'An envelope declares exactly one resolution choice: explicit provider/model or named profile.');
  }
  if (hasExplicit && !hasModel) {
    fail('missing_key', 'envelope.execution.model', 'Explicit execution requires an exact model identifier.');
  }
  if (!hasExplicit && hasModel) {
    fail('discarded_model_with_profile', 'envelope.execution.model',
      'A profile-selected execution must leave execution.model as "-"; a concrete model value here would be silently discarded by the parse.');
  }
  const startingRefRaw = expectLine(reader, 'starting_ref');
  let startingRef = null;
  if (startingRefRaw !== '-') {
    startingRef = expectPatternedValue(startingRefRaw, SHA40_PATTERN, 40, 'envelope.starting_ref', 'starting_ref');
  }
  if (hasExplicit && providerRaw === 'cursor-cloud' && startingRef === null) {
    fail('cloud_starting_ref_required', 'envelope.starting_ref',
      'Every run cursor-cloud lane pins one exact provider-visible starting SHA.');
  }
  if (hasExplicit && providerRaw !== 'cursor-cloud' && startingRef !== null) {
    fail('starting_ref_forbidden_local', 'envelope.starting_ref',
      'Local lanes start at the run immutable base_sha and never carry a starting_ref.');
  }

  const scopeCount = decimalInt(expectLine(reader, 'write_scope.count'), 'envelope.write_scope.count', { min: 0, max: SCOPE_MAX_PATTERNS });
  if (access === 'read_only' && scopeCount !== 0) {
    fail('out_of_range', 'envelope.write_scope.count', 'Read-only lanes declare an empty write scope.');
  }
  if (access === 'writer' && scopeCount === 0) {
    fail('out_of_range', 'envelope.write_scope.count', 'Writer lanes declare at least one owned path pattern.');
  }
  const writeScope = [];
  for (let index = 0; index < scopeCount; index += 1) {
    writeScope.push(expectLine(reader, `write_scope[${index}]`));
  }
  assertWriteScopePatterns(writeScope, 'envelope.write_scope', {
    minPatterns: access === 'writer' ? 1 : 0,
    maxPatterns: access === 'writer' ? SCOPE_MAX_PATTERNS : 0,
  });

  const acceptanceCount = decimalInt(expectLine(reader, 'acceptance.count'), 'envelope.acceptance.count', { min: 0, max: ACCEPTANCE_MAX_COMMANDS });
  const seenCommandIds = new Set();
  const acceptance = [];
  for (let index = 0; index < acceptanceCount; index += 1) {
    const prefix = `acceptance[${index}]`;
    const commandId = expectPatternedValue(
      expectLine(reader, `${prefix}.command_id`), COMMAND_ID_PATTERN, COMMAND_ID_MAX,
      `envelope.${prefix}.command_id`, 'command_id',
    );
    if (seenCommandIds.has(commandId)) {
      fail('duplicate_command_id', `envelope.${prefix}.command_id`, `command_id "${commandId}" repeats within this assignment.`);
    }
    seenCommandIds.add(commandId);
    const timeoutMs = decimalInt(
      expectLine(reader, `${prefix}.timeout_ms`), `envelope.${prefix}.timeout_ms`,
      { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS },
    );
    assertTimeoutMs(timeoutMs, `envelope.${prefix}.timeout_ms`);
    const parameterCount = decimalInt(expectLine(reader, `${prefix}.parameter.count`), `envelope.${prefix}.parameter.count`, { min: 0, max: PARAMS_MAX_KEYS });
    const parameters = {};
    const parameterPrefix = `${prefix}.parameter.`;
    let previousParameterKey = null;
    for (let paramIndex = 0; paramIndex < parameterCount; paramIndex += 1) {
      const lineText = readScaffoldLine(reader);
      const parsed = splitScaffoldLine(lineText);
      if (!parsed.key.startsWith(parameterPrefix)) {
        fail('malformed_envelope', `envelope.${parameterPrefix}<key>`,
          `Expected parameter line "${parameterPrefix}<key>: ...", found "${truncateForMessage(parsed.key)}".`);
      }
      const parameterKey = parsed.key.slice(parameterPrefix.length);
      if (!PARAM_KEY_PATTERN.test(parameterKey)) {
        fail('invalid_format', `envelope.${parsed.key}`, `Parameter key "${truncateForMessage(parameterKey)}" violates the parameter-key grammar.`);
      }
      if (Object.hasOwn(parameters, parameterKey)) {
        fail('duplicate_parameter_key', `envelope.${parsed.key}`, `Parameter "${parameterKey}" repeats within acceptance command "${commandId}".`);
      }
      if (previousParameterKey !== null && parameterKey < previousParameterKey) {
        fail('noncanonical_parameter_order', `envelope.${parsed.key}`,
          `Acceptance parameters must use the compiler's ascending key order; "${parameterKey}" follows "${previousParameterKey}".`);
      }
      parameters[parameterKey] = parseJsonScalar(parsed.value, `envelope.${parsed.key}`);
      previousParameterKey = parameterKey;
    }
    acceptance.push(Object.freeze({ command_id: commandId, timeout_ms: timeoutMs, parameters }));
  }

  const evidenceCount = decimalInt(expectLine(reader, 'required_evidence.count'), 'envelope.required_evidence.count', { min: 1, max: EVIDENCE_KINDS.length });
  const seenEvidence = new Set();
  const requiredEvidence = [];
  for (let index = 0; index < evidenceCount; index += 1) {
    const kind = expectLine(reader, `required_evidence[${index}]`);
    if (!EVIDENCE_KINDS.includes(kind)) {
      fail('unknown_evidence_kind', `envelope.required_evidence[${index}]`, `"${truncateForMessage(kind)}" is not one of ${EVIDENCE_KINDS.join(', ')}.`);
    }
    if (seenEvidence.has(kind)) {
      fail('duplicate_evidence_kind', `envelope.required_evidence[${index}]`, `Evidence kind "${kind}" repeats.`);
    }
    seenEvidence.add(kind);
    requiredEvidence.push(kind);
  }
  const promptBlock = expectBlock(reader, 'prompt', 'envelope.prompt');
  assertBoundedText(promptBlock.content, {
    min: PROMPT_MIN_BYTES, max: PROMPT_MAX_BYTES, path: 'envelope.prompt', label: 'prompt',
  });
  if (reader.offset !== reader.bytes.length) {
    fail('malformed_envelope', 'envelope', 'Envelope carries trailing content after the final framed block.');
  }

  return deepFreezeJson({
    schema,
    version,
    run_id: runId,
    lane_index: laneIndex,
    assignment_count: assignmentCount,
    repository: { path: repositoryPath, base_sha: baseSha },
    assignment_id: assignmentId,
    role,
    access,
    execution: {
      provider: hasExplicit ? providerRaw : null,
      model: hasExplicit ? modelRaw : null,
      profile: hasProfile ? profileRaw : null,
    },
    starting_ref: startingRef,
    write_scope: writeScope,
    acceptance,
    required_evidence: requiredEvidence,
    objective: objectiveBlock.content,
    prompt: promptBlock.content,
    framed_blocks: {
      objective: { byte_offset: objectiveBlock.byte_offset, byte_length: objectiveBlock.byte_length },
      prompt: { byte_offset: promptBlock.byte_offset, byte_length: promptBlock.byte_length },
    },
    envelope_byte_length: reader.bytes.length,
    envelope_text: envelopeText,
  });
}
