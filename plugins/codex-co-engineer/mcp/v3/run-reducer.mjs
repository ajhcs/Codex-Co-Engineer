// Pure deterministic run-journal reducer (P25). This module owns the closed
// run-journal event vocabulary, the per-child/run transition lattice, and the
// monotonic terminal-absorbing derived state projection. It performs no I/O,
// reads no clock, and draws no randomness: identical inputs always reduce to
// the identical frozen state, so an exact journal replay after a crash or
// restart reproduces the exact derived state.
//
// Closed event kinds and payloads:
//   run_opened      {}                                        (exactly seq 1)
//   child_started   { assignment_id }
//   child_progress  { assignment_id, note }
//   child_artifact  { assignment_id, artifact: { digest, bytes } }
//   child_terminal  { assignment_id, outcome }
//   run_terminal    { outcome }
//
// Artifact references are closed content-addressed shapes (digest plus byte
// length) only. This module never verifies artifact bytes (P08/P10), never
// invokes a scheduler or provider, and never reduces attention batches.
//
// The reducer enforces the logical hash-chain linkage (`prev` must equal the
// current head hash and `hash` must carry the journal hash shape); the
// cryptographic digest computation itself lives in run-journal.mjs so this
// module stays free of crypto and filesystem dependencies.

import {
  capturedCreate,
  capturedFreeze,
  capturedIncludes,
  capturedTest,
  capturedUtf8ByteLength,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import { ASSIGNMENT_ID_PATTERN } from './run-manifest.mjs';
import {
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  assertPlainObject,
  fail,
  hasOwn,
} from './selection-json.mjs';

export const RUN_JOURNAL_ENTRY_SCHEMA_ID = 'codex-co-engineer.run-journal-entry.v1';
export const RUN_JOURNAL_STATE_SCHEMA_ID = 'codex-co-engineer.run-journal-state.v1';
export const RUN_JOURNAL_HASH_DOMAIN = 'codex-co-engineer.run-journal-hash.v1';
export const RUN_JOURNAL_GENESIS_PREV = 'codex-co-engineer.run-journal.genesis.v1';

export const RUN_JOURNAL_EVENT_KINDS = capturedFreeze([
  'run_opened', 'child_started', 'child_progress', 'child_artifact',
  'child_terminal', 'run_terminal',
]);
export const RUN_JOURNAL_OUTCOMES = capturedFreeze(['completed', 'failed', 'cancelled']);
export const MAX_RUN_JOURNAL_CHILDREN = 8;
export const MAX_RUN_JOURNAL_NOTE_BYTES = 64;
export const MAX_RUN_JOURNAL_DEDUPE_KEY_BYTES = 128;
export const MAX_RUN_JOURNAL_ARTIFACT_BYTES = 1_073_741_824;

const NOTE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const DEDUPE_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/u;
const HASH_SHAPE_PATTERN = SHA256_DIGEST_PATTERN;
const ENTRY_KEYS = capturedFreeze(['schema', 'seq', 'kind', 'data', 'dedupe_key', 'prev', 'hash']);
const STATE_KEYS = capturedFreeze([
  'schema', 'revision', 'head_hash', 'run_opened', 'children', 'child_count',
  'event_counts', 'artifacts_total', 'artifact_bytes_total', 'run_outcome',
  'terminal',
]);

const STRING = String;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

function failReducer(code, path, message) {
  fail(code, path, message);
}

function assertSafePositiveInt(value, path) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || value < 1) {
    failReducer('invalid_format', path, `${path} must be a positive safe integer.`);
  }
  return value;
}

function assertHashShape(value, path, allowGenesis = false) {
  if (typeof value !== 'string') {
    failReducer('invalid_format', path, `${path} must be a hash chain string.`);
  }
  if (capturedTest(HASH_SHAPE_PATTERN, value)) return value;
  if (allowGenesis && value === RUN_JOURNAL_GENESIS_PREV) return value;
  failReducer('invalid_format', path, `${path} must be a sha256 digest or the genesis marker.`);
}

function assertAssignmentId(value, path) {
  if (typeof value !== 'string' || !capturedTest(ASSIGNMENT_ID_PATTERN, value)) {
    failReducer('invalid_format', path, `${path} must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
  return value;
}

function assertClosedData(value, path, allowed) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    failReducer('invalid_type', path, `${path} must be a plain JSON data object.`);
  }
  assertDirectJsonClosure(value, path);
  assertPlainObject(value, 'invalid_type', path, path);
  const keys = sortedCapturedKeys(value);
  if (keys.length !== allowed.length) {
    failReducer('unknown_key', path, `${path} must carry exactly the closed payload keys.`);
  }
  for (const key of keys) {
    if (!capturedIncludes(allowed, key)) {
      failReducer('unknown_key', `${path}.${key}`, `${path}.${key} is not part of the closed event payload.`);
    }
  }
  return value;
}

function assertNote(value, path) {
  if (typeof value !== 'string' || !capturedTest(NOTE_PATTERN, value)
    || capturedUtf8ByteLength(value) > MAX_RUN_JOURNAL_NOTE_BYTES) {
    failReducer('invalid_format', path,
      `${path} must be a bounded content-free progress note code.`);
  }
  return value;
}

function assertDedupeKey(value, path) {
  if (typeof value !== 'string' || !capturedTest(DEDUPE_KEY_PATTERN, value)
    || capturedUtf8ByteLength(value) > MAX_RUN_JOURNAL_DEDUPE_KEY_BYTES) {
    failReducer('invalid_format', path,
      `${path} must be 1-128 printable ASCII characters without whitespace.`);
  }
  return value;
}

function assertArtifactRef(value, path) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    failReducer('invalid_type', path, `${path} must be a closed artifact reference object.`);
  }
  assertDirectJsonClosure(value, path);
  const keys = sortedCapturedKeys(value);
  if (keys.length !== 2 || keys[0] !== 'bytes' || keys[1] !== 'digest') {
    failReducer('unknown_key', path,
      `${path} must carry exactly the closed { bytes, digest } artifact reference shape.`);
  }
  if (typeof value.digest !== 'string' || !capturedTest(HASH_SHAPE_PATTERN, value.digest)) {
    failReducer('invalid_format', `${path}.digest`,
      `${path}.digest must be a sha256:<64 hex> content digest.`);
  }
  const bytes = value.bytes;
  if (typeof bytes !== 'number' || !NUMBER_IS_SAFE_INTEGER(bytes)
    || bytes < 1 || bytes > MAX_RUN_JOURNAL_ARTIFACT_BYTES) {
    failReducer('invalid_format', `${path}.bytes`,
      `${path}.bytes must be a safe integer within the bounded artifact size.`);
  }
  return { bytes, digest: value.digest };
}

// Validates one closed event payload for `kind` and returns the normalized
// frozen { kind, data } pair. Shared by append-time validation and replay.
export function validateRunJournalEventDataV1(kind, data) {
  if (!capturedIncludes(RUN_JOURNAL_EVENT_KINDS, kind)) {
    failReducer('invalid_format', 'kind', 'Event kind is not part of the closed run-journal vocabulary.');
  }
  if (kind === 'run_opened') {
    assertClosedData(data, 'data', []);
    return { kind, data: {} };
  }
  if (kind === 'run_terminal') {
    const fields = assertClosedData(data, 'data', ['outcome']);
    if (!capturedIncludes(RUN_JOURNAL_OUTCOMES, fields.outcome)) {
      failReducer('invalid_format', 'data.outcome',
        'data.outcome must be a closed terminal run outcome.');
    }
    return { kind, data: { outcome: fields.outcome } };
  }
  if (kind === 'child_started') {
    const fields = assertClosedData(data, 'data', ['assignment_id']);
    return {
      kind,
      data: { assignment_id: assertAssignmentId(fields.assignment_id, 'data.assignment_id') },
    };
  }
  if (kind === 'child_progress') {
    const fields = assertClosedData(data, 'data', ['assignment_id', 'note']);
    return {
      kind,
      data: {
        assignment_id: assertAssignmentId(fields.assignment_id, 'data.assignment_id'),
        note: assertNote(fields.note, 'data.note'),
      },
    };
  }
  if (kind === 'child_artifact') {
    const fields = assertClosedData(data, 'data', ['assignment_id', 'artifact']);
    return {
      kind,
      data: {
        assignment_id: assertAssignmentId(fields.assignment_id, 'data.assignment_id'),
        artifact: assertArtifactRef(fields.artifact, 'data.artifact'),
      },
    };
  }
  const fields = assertClosedData(data, 'data', ['assignment_id', 'outcome']);
  if (!capturedIncludes(RUN_JOURNAL_OUTCOMES, fields.outcome)) {
    failReducer('invalid_format', 'data.outcome',
      'data.outcome must be a closed terminal child outcome.');
  }
  return {
    kind,
    data: {
      assignment_id: assertAssignmentId(fields.assignment_id, 'data.assignment_id'),
      outcome: fields.outcome,
    },
  };
}

// Validates the closed envelope of one journal entry (shapes and formats
// only; chain linkage and lattice legality are enforced by reduction).
export function validateRunJournalEntryV1(entry) {
  if (entry === undefined || entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    failReducer('invalid_type', 'entry', 'A journal entry must be a plain JSON data object.');
  }
  assertDirectJsonClosure(entry, 'entry');
  for (const key of sortedCapturedKeys(entry)) {
    if (!capturedIncludes(ENTRY_KEYS, key)) {
      failReducer('unknown_key', `entry.${key}`, `entry.${key} is not part of the closed entry shape.`);
    }
  }
  for (const key of ['schema', 'seq', 'kind', 'data', 'prev', 'hash']) {
    if (!hasOwn(entry, key)) failReducer('missing_key', `entry.${key}`, `entry.${key} is required.`);
  }
  if (entry.schema !== RUN_JOURNAL_ENTRY_SCHEMA_ID) {
    failReducer('invalid_format', 'entry.schema',
      `entry.schema must be exactly "${RUN_JOURNAL_ENTRY_SCHEMA_ID}".`);
  }
  const seq = assertSafePositiveInt(entry.seq, 'entry.seq');
  if (hasOwn(entry, 'dedupe_key')) assertDedupeKey(entry.dedupe_key, 'entry.dedupe_key');
  const { kind, data } = validateRunJournalEventDataV1(entry.kind, entry.data);
  const prev = assertHashShape(entry.prev, 'entry.prev', true);
  const hash = assertHashShape(entry.hash, 'entry.hash', false);
  return {
    schema: RUN_JOURNAL_ENTRY_SCHEMA_ID,
    seq,
    kind,
    data,
    ...(hasOwn(entry, 'dedupe_key') ? { dedupe_key: entry.dedupe_key } : {}),
    prev,
    hash,
  };
}

// The empty derived state. `head_hash` is the genesis marker until the first
// committed entry extends the chain.
export function emptyRunJournalStateV1() {
  const counts = capturedCreate(null);
  for (const kind of RUN_JOURNAL_EVENT_KINDS) counts[kind] = 0;
  return {
    schema: RUN_JOURNAL_STATE_SCHEMA_ID,
    revision: 0,
    head_hash: RUN_JOURNAL_GENESIS_PREV,
    run_opened: false,
    children: [],
    child_count: 0,
    event_counts: counts,
    artifacts_total: 0,
    artifact_bytes_total: 0,
    run_outcome: null,
    terminal: false,
  };
}

function childIndex(state, assignmentId) {
  for (let index = 0; index < state.children.length; index += 1) {
    if (state.children[index].assignment_id === assignmentId) return index;
  }
  return -1;
}

function childAt(state, assignmentId, path) {
  const index = childIndex(state, assignmentId);
  if (index < 0) {
    failReducer('run_journal_child_unknown', path,
      'The event names a child that never started in this run journal.');
  }
  return state.children[index];
}

function insertChildSorted(children, child) {
  const index = children.findIndex((existing) => existing.assignment_id > child.assignment_id);
  if (index < 0) return [...children, child];
  return [...children.slice(0, index), child, ...children.slice(index)];
}

function assertOpenAndLive(state) {
  if (!state.run_opened) {
    failReducer('run_journal_not_opened', 'kind',
      'The first journal entry must be a run_opened event.');
  }
  if (state.terminal) {
    failReducer('run_journal_terminal_absorbed', 'kind',
      'The run journal reached its absorbing terminal state; no further event is legal.');
  }
}

// Applies one validated entry to `state` and returns the next frozen state.
// Throws typed RunContractV1Error values for dense-sequence violations,
// chain-linkage breaks, illegal lattice transitions, and terminal-absorption
// violations. Never mutates `state`.
export function applyRunJournalEntryV1(state, entry) {
  const normalized = validateRunJournalEntryV1(entry);
  if (normalized.seq !== state.revision + 1) {
    failReducer('run_journal_sequence_invalid', 'entry.seq',
      'Journal entries must carry the next dense sequence number.');
  }
  if (normalized.prev !== state.head_hash) {
    failReducer('run_journal_chain_break', 'entry.prev',
      'The entry does not extend the current hash chain head.');
  }
  const { kind, data } = normalized;
  if (kind === 'run_opened') {
    if (state.revision !== 0 || state.run_opened) {
      failReducer('run_journal_transition_invalid', 'kind',
        'run_opened is legal only as the very first journal entry.');
    }
  } else {
    assertOpenAndLive(state);
  }
  const children = [...state.children];
  const eventCounts = { ...state.event_counts };
  let artifactsTotal = state.artifacts_total;
  let artifactBytesTotal = state.artifact_bytes_total;
  let runOutcome = state.run_outcome;
  let terminal = state.terminal;

  if (kind === 'child_started') {
    if (childIndex(state, data.assignment_id) >= 0) {
      failReducer('run_journal_transition_invalid', 'data.assignment_id',
        'The child already started; starts are not repeatable.');
    }
    if (state.child_count >= MAX_RUN_JOURNAL_CHILDREN) {
      failReducer('run_journal_children_exceeded', 'data.assignment_id',
        `A run journal binds at most ${MAX_RUN_JOURNAL_CHILDREN} children.`);
    }
    children.push({
      assignment_id: data.assignment_id,
      started_seq: normalized.seq,
      progress_events: 0,
      artifact_events: 0,
      artifact_bytes: 0,
      outcome: null,
      terminal_seq: null,
    });
    children.sort((left, right) => (left.assignment_id < right.assignment_id ? -1 : 1));
  } else if (kind === 'child_progress' || kind === 'child_artifact') {
    const index = childIndex(state, data.assignment_id);
    if (index < 0) {
      failReducer('run_journal_child_unknown', 'data.assignment_id',
        'The event names a child that never started in this run journal.');
    }
    const child = children[index];
    if (child.outcome !== null) {
      failReducer('run_journal_transition_invalid', 'data.assignment_id',
        'The child already reached an absorbing terminal outcome.');
    }
    children[index] = kind === 'child_progress'
      ? { ...child, progress_events: child.progress_events + 1 }
      : {
        ...child,
        artifact_events: child.artifact_events + 1,
        artifact_bytes: child.artifact_bytes + data.artifact.bytes,
      };
    if (kind === 'child_artifact') {
      artifactsTotal += 1;
      artifactBytesTotal += data.artifact.bytes;
    }
  } else if (kind === 'child_terminal') {
    const index = childIndex(state, data.assignment_id);
    if (index < 0) {
      failReducer('run_journal_child_unknown', 'data.assignment_id',
        'The event names a child that never started in this run journal.');
    }
    const child = children[index];
    if (child.outcome !== null) {
      failReducer('run_journal_transition_invalid', 'data.assignment_id',
        'The child outcome is already absorbing and cannot be rewritten.');
    }
    children[index] = { ...child, outcome: data.outcome, terminal_seq: normalized.seq };
  } else if (kind === 'run_terminal') {
    if (state.child_count < 1 || children.some((child) => child.outcome === null)) {
      failReducer('run_journal_transition_invalid', 'kind',
        'run_terminal is legal only once every started child reached a terminal outcome.');
    }
    runOutcome = data.outcome;
    terminal = true;
  }

  eventCounts[kind] += 1;
  const next = {
    schema: RUN_JOURNAL_STATE_SCHEMA_ID,
    revision: normalized.seq,
    head_hash: normalized.hash,
    run_opened: kind === 'run_opened' ? true : state.run_opened,
    children,
    child_count: kind === 'child_started'
      ? state.child_count + 1
      : state.child_count,
    event_counts: eventCounts,
    artifacts_total: artifactsTotal,
    artifact_bytes_total: artifactBytesTotal,
    run_outcome: runOutcome,
    terminal,
  };
  assertStateShape(next, 'state');
  return freezeState(next);
}

// Validates the closed derived-state shape and its internal counter
// invariants. Used by the journal to audit a persisted state cache against
// tampering before the exact replay comparison.
export function validateRunJournalStateV1(state) {
  return assertStateShape(state, 'state');
}

// Folds a full entry stream from the empty state. Exact replay primitive.
export function reduceRunJournalEntriesV1(entries) {
  let state = freezeState(emptyRunJournalStateV1());
  for (const entry of entries) {
    state = applyRunJournalEntryV1(state, entry);
  }
  return state;
}

function assertStateShape(state, path) {
  if (state === undefined || state === null || typeof state !== 'object' || Array.isArray(state)) {
    failReducer('invalid_type', path, `${path} must be a plain derived-state object.`);
  }
  assertDirectJsonClosure(state, path);
  for (const key of sortedCapturedKeys(state)) {
    if (!capturedIncludes(STATE_KEYS, key)) {
      failReducer('unknown_key', `${path}.${key}`, `${path}.${key} is not part of the closed derived state.`);
    }
  }
  for (const key of STATE_KEYS) {
    if (!hasOwn(state, key)) failReducer('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
  }
  if (state.schema !== RUN_JOURNAL_STATE_SCHEMA_ID) {
    failReducer('invalid_format', `${path}.schema`,
      `${path}.schema must be exactly "${RUN_JOURNAL_STATE_SCHEMA_ID}".`);
  }
  if (typeof state.revision !== 'number' || !NUMBER_IS_SAFE_INTEGER(state.revision)
    || state.revision < 0) {
    failReducer('invalid_format', `${path}.revision`, `${path}.revision must be a non-negative safe integer.`);
  }
  assertHashShape(state.head_hash, `${path}.head_hash`, true);
  if (typeof state.run_opened !== 'boolean' || typeof state.terminal !== 'boolean') {
    failReducer('invalid_type', `${path}.run_opened`, `${path} flags must be booleans.`);
  }
  if (!Array.isArray(state.children)) {
    failReducer('invalid_type', `${path}.children`, `${path}.children must be an array.`);
  }
  if (state.children.length !== state.child_count) {
    failReducer('invalid_format', `${path}.child_count`,
      `${path}.child_count must equal the children array length.`);
  }
  if (state.child_count > MAX_RUN_JOURNAL_CHILDREN) {
    failReducer('run_journal_children_exceeded', `${path}.child_count`,
      `${path} binds at most ${MAX_RUN_JOURNAL_CHILDREN} children.`);
  }
  for (const child of state.children) {
    if (child === null || typeof child !== 'object') {
      failReducer('invalid_type', `${path}.children`, 'Child records must be plain objects.');
    }
    assertAssignmentId(child.assignment_id, `${path}.child.assignment_id`);
    assertSafePositiveInt(child.started_seq, `${path}.child.started_seq`);
    for (const counter of ['progress_events', 'artifact_events', 'artifact_bytes']) {
      if (typeof child[counter] !== 'number' || !NUMBER_IS_SAFE_INTEGER(child[counter])
        || child[counter] < 0) {
        failReducer('invalid_format', `${path}.child.${counter}`,
          `${path}.child.${counter} must be a non-negative safe integer.`);
      }
    }
    if (child.outcome !== null && !capturedIncludes(RUN_JOURNAL_OUTCOMES, child.outcome)) {
      failReducer('invalid_format', `${path}.child.outcome`,
        `${path}.child.outcome must be null or a closed terminal outcome.`);
    }
    if ((child.outcome === null) !== (child.terminal_seq === null)) {
      failReducer('invalid_format', `${path}.child.terminal_seq`,
        `${path}.child terminal fields must agree.`);
    }
  }
  const counts = state.event_counts;
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    failReducer('invalid_type', `${path}.event_counts`, `${path}.event_counts must be an object.`);
  }
  for (const kind of RUN_JOURNAL_EVENT_KINDS) {
    const value = counts[kind];
    if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || value < 0) {
      failReducer('invalid_format', `${path}.event_counts.${kind}`,
        `${path}.event_counts.${kind} must be a non-negative safe integer.`);
    }
  }
  if (state.revision > 0 && !state.run_opened) {
    failReducer('invalid_format', `${path}.run_opened`,
      `${path} must stay run_opened once any entry is reduced.`);
  }
  if (state.run_outcome !== null && !capturedIncludes(RUN_JOURNAL_OUTCOMES, state.run_outcome)) {
    failReducer('invalid_format', `${path}.run_outcome`,
      `${path}.run_outcome must be null or a closed terminal outcome.`);
  }
  if ((state.run_outcome === null) !== !state.terminal) {
    failReducer('invalid_format', `${path}.terminal`, `${path} terminal fields must agree.`);
  }
  let countedEvents = 0;
  for (const kind of RUN_JOURNAL_EVENT_KINDS) countedEvents += counts[kind];
  if (countedEvents !== state.revision) {
    failReducer('invalid_format', `${path}.event_counts`,
      `${path}.event_counts must sum to the reduced revision.`);
  }
  let countedArtifacts = 0;
  let countedArtifactBytes = 0;
  let countedStarted = 0;
  for (const child of state.children) {
    countedArtifacts += child.artifact_events;
    countedArtifactBytes += child.artifact_bytes;
    countedStarted += 1;
  }
  if (countedArtifacts !== state.artifacts_total
    || countedArtifactBytes !== state.artifact_bytes_total
    || countedStarted !== counts.child_started) {
    failReducer('invalid_format', `${path}.artifacts_total`,
      `${path} artifact and child counters must match the reduced children.`);
  }
  return state;
}

function freezeState(state) {
  assertStateShape(state, 'state');
  const frozen = capturedFreeze({ ...state });
  capturedFreeze(frozen.children);
  for (const child of frozen.children) capturedFreeze(child);
  capturedFreeze(frozen.event_counts);
  return frozen;
}

capturedFreeze(validateRunJournalEventDataV1);
capturedFreeze(validateRunJournalEntryV1);
capturedFreeze(emptyRunJournalStateV1);
capturedFreeze(applyRunJournalEntryV1);
capturedFreeze(validateRunJournalStateV1);
capturedFreeze(reduceRunJournalEntriesV1);
