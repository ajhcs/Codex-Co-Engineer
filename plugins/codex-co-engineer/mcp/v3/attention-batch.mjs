// Atomic AttentionBatchV1 persistence (P34; ADR 0001 identifiers
// `attention_batch_v1`, `exact_identities`, `bounded_evidence`,
// `no_post_dispatch_fallback_or_replay`; Gate A
// `gate_a_decision_or_attention_no_silent_unanswerable`).
//
// Additive v3 module. It owns one immutable latched question set per run
// inside a caller-supplied existing private attention root, never under or
// inside accepted P25. The durable file is
//   <root>/runs/<run_id>/attention-batch.v1.json
// with 0700 directories, 0600 files, no-follow identity checks,
// same-directory temporary + file fsync + atomic rename + directory fsync,
// and expected_revision CAS.
//
// One reply round is durable before any injected mailbox delivery. Restart
// retries only exact latched identities. Unsupported DSH / Cursor Cloud
// items become unresolved and cancel only the affected lane. Required
// unresolved evidence blocks a complete candidate. Routine progress never
// wakes. This module does not append P25 events, encode questions in
// child_progress.note, invoke a scheduler or provider, compose a candidate,
// expose a server/tool, implement cleanup, or claim Gate A / release.

import { Buffer as NodeBuffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  capturedCreate,
  capturedFreeze,
  capturedHasOwn,
  capturedIncludes,
  capturedIsArray,
  capturedJoin,
  capturedTest,
  capturedUtf8ByteLength,
  isKnownProvider,
  knownProvidersJoined,
  sortedCapturedKeys,
} from './grammar.mjs';
import { canonicalJsonStringify } from './identity.mjs';
import {
  ASSIGNMENT_ID_PATTERN,
  RunContractV1Error,
  assertRunId,
  isAssignmentId,
  utf8ByteLength,
} from './run-manifest.mjs';
import {
  SHA256_DIGEST_PATTERN,
  assertDirectJsonClosure,
  assertNotProxy,
  fail,
  freezeData,
  hasOwn,
  ownDataValue,
} from './selection-json.mjs';
import { closedObject, snapshotRecord } from './protected-identity.mjs';

export const ATTENTION_BATCH_SCHEMA_ID = 'codex-co-engineer.attention-batch.v1';
export const ATTENTION_BATCH_VERSION = 1;
export const ATTENTION_BATCH_RECEIPT_SCHEMA_ID =
  'codex-co-engineer.attention-batch-receipt.v1';
export const ATTENTION_BATCH_HASH_DOMAIN = 'codex-co-engineer.attention-batch-hash.v1';
export const ATTENTION_BATCH_FILE_NAME = 'attention-batch.v1.json';
export const RUN_JOURNAL_GENESIS_PREV = 'codex-co-engineer.run-journal.genesis.v1';

export const ATTENTION_BATCH_RECORD_KEYS = capturedFreeze([
  'schema', 'version', 'run_id', 'batch_id', 'revision', 'status',
  'source', 'items', 'reply', 'unresolved',
]);
export const ATTENTION_BATCH_STATUSES = capturedFreeze([
  'open', 'reply_committed', 'resolved',
]);
export const ATTENTION_BATCH_SOURCE_KEYS = capturedFreeze([
  'journal_revision', 'journal_head_hash', 'task_cursors',
]);
export const ATTENTION_BATCH_TASK_CURSOR_KEYS = capturedFreeze([
  'assignment_id', 'task_id', 'event_cursor',
]);
export const ATTENTION_BATCH_ITEM_KEYS = capturedFreeze([
  'assignment_id', 'task_id', 'provider', 'required', 'session_id',
  'question_id', 'event_cursor', 'question_digest', 'prompt', 'options',
  'reply_capability', 'disposition', 'deadline_at',
]);
export const ATTENTION_BATCH_OPTION_KEYS = capturedFreeze([
  'optionId', 'kind', 'name', 'label', 'description',
]);
const ATTENTION_BATCH_OPTION_REQUIRED_KEYS = capturedFreeze(['kind']);
export const ATTENTION_BATCH_PROVIDERS = capturedFreeze([
  'grok', 'cursor-local', 'cursor-cloud', 'dsh',
]);
export const ATTENTION_BATCH_REPLY_CAPABILITIES = capturedFreeze([
  'same_session', 'unsupported',
]);
export const ATTENTION_BATCH_DISPOSITIONS = capturedFreeze([
  'pending', 'answered', 'unresolved',
]);
export const ATTENTION_BATCH_UNRESOLVED_CODES = capturedFreeze([
  'same_session_reply_unsupported',
  'late_attention_after_latch',
  'reply_delivery_failed',
  'reply_deadline_expired',
  'safe_cancel_unconfirmed',
]);
export const ATTENTION_BATCH_REPLY_KEYS = capturedFreeze([
  'answers', 'batch_id', 'round',
]);
export const ATTENTION_BATCH_ANSWER_KEYS = capturedFreeze([
  'assignment_id', 'question_id', 'response', 'session_id', 'task_id',
]);
export const ATTENTION_BATCH_UNRESOLVED_KEYS = capturedFreeze([
  'assignment_id', 'code', 'question_id', 'required', 'session_id', 'task_id',
]);

export const MIN_ATTENTION_ITEMS = 1;
export const MAX_ATTENTION_ITEMS = 8;
export const MAX_ATTENTION_OPTIONS = 8;
export const MAX_ATTENTION_PROMPT_BYTES = 4096;
export const MAX_ATTENTION_OPTION_BYTES = 128;
export const MAX_ATTENTION_RESPONSE_BYTES = 16_384;
export const ATTENTION_REPLY_ROUND = 1;
export const MAX_ATTENTION_BATCH_RECORD_BYTES = 131_072;
export const MAX_ATTENTION_BATCH_DIAGNOSTIC_BYTES = 160;
export const MAX_ATTENTION_RUN_DIRECTORIES = 256;
export const MAX_ATTENTION_DIRECTORY_ENTRIES = 16;
export const MAX_ATTENTION_ROOT_ENTRIES = 8;
export const MAX_ATTENTION_BATCH_TEMPORARIES = 8;
export const MAX_ATTENTION_FILENAME_BYTES = 80;

export const ATTENTION_BATCH_ERROR_CODES = capturedFreeze([
  'accessor_property_denied',
  'attention_batch_foreign_entry',
  'attention_batch_identity_mismatch',
  'attention_batch_io_failed',
  'attention_batch_not_found',
  'attention_batch_not_regular',
  'attention_batch_path_unsafe',
  'attention_batch_publish_unverified',
  'attention_batch_record_too_large',
  'attention_batch_reply_conflict',
  'attention_batch_revision_conflict',
  'attention_batch_root_missing',
  'attention_batch_root_shared',
  'attention_batch_root_unsafe',
  'attention_batch_too_many_entries',
  'capability_reply_mismatch',
  'duplicate_assignment_id',
  'exotic_prototype_denied',
  'invalid_format',
  'invalid_type',
  'missing_key',
  'own_undefined_denied',
  'out_of_range',
  'proxy_denied',
  'symbol_key_denied',
  'unknown_key',
]);

const RUNS_NAME = 'runs';
const RECORD_NAME = ATTENTION_BATCH_FILE_NAME;
const P25_FOREIGN_NAMES = capturedFreeze([
  'created.json', 'journal.jsonl', 'lock', 'state.json',
]);
const TEMP_NAME_PATTERN = /^\.tmp-[0-9a-f]{32}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_CURSOR_PATTERN = /^[0-9]{1,16}$/u;
const BATCH_ID_PATTERN = /^att-[0-9a-f]{32}$/u;
const DEADLINE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const HASH_ALGORITHM = 'sha256';
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const BUFFER_FROM = NodeBuffer.from.bind(NodeBuffer);
const CREATE_HASH = createHash;
const RANDOM_BYTES = randomBytes;
const TIMING_SAFE_EQUAL = timingSafeEqual;
const JSON_PARSE = JSON.parse;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING = String;
const ARRAY_FROM = Array.from;
const ROOT_CHAINS = new Map();

const ROOT_OPEN_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const FILE_CREATE_FLAGS = fsConstants.O_WRONLY
  | fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | (fsConstants.O_NOFOLLOW ?? 0);

const LATCH_ALLOWED_KEYS = capturedFreeze([
  'cancel', 'expected_revision', 'items', 'now', 'run_id', 'source',
]);
const LATCH_REQUIRED_KEYS = capturedFreeze([
  'expected_revision', 'items', 'run_id', 'source',
]);
const REPLY_ALLOWED_KEYS = capturedFreeze([
  'batch_id', 'cancel', 'deliver', 'expected_revision', 'now', 'reply', 'run_id',
]);
const REPLY_REQUIRED_KEYS = capturedFreeze([
  'batch_id', 'expected_revision', 'reply', 'run_id',
]);
const FUNCTION_KEYS = capturedFreeze(['cancel', 'deliver']);

function diagnostic(value) {
  const text = STRING(value ?? '');
  return text.length <= MAX_ATTENTION_BATCH_DIAGNOSTIC_BYTES
    ? text
    : text.slice(0, MAX_ATTENTION_BATCH_DIAGNOSTIC_BYTES);
}

function failBatch(code, field, message) {
  fail(code, field, diagnostic(message));
}

function mapErrno(error, field, code, message) {
  if (error instanceof RunContractV1Error) throw error;
  const errno = error?.code;
  if (errno === 'ENOENT') {
    failBatch('attention_batch_root_missing', field, 'The attention path does not exist.');
  }
  if (errno === 'ELOOP' || errno === 'ENOTDIR') {
    failBatch('attention_batch_root_unsafe', field,
      'The attention path is not a real directory entry.');
  }
  if (errno === 'EEXIST') failBatch(code, field, message);
  failBatch(code, field, message);
}

function assertSafeRootPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failBatch('attention_batch_root_unsafe', 'root',
      'Attention root must be an absolute directory path.');
  }
  if (!path.isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    failBatch('attention_batch_path_unsafe', 'root',
      'Attention root must be an absolute, NUL-free path.');
  }
  if (value !== '/' && value.endsWith('/')) {
    failBatch('attention_batch_path_unsafe', 'root',
      'Attention root must not end with a trailing slash.');
  }
  if (path.normalize(value) !== value) {
    failBatch('attention_batch_path_unsafe', 'root',
      'Attention root must be a normalized absolute path.');
  }
  for (const part of value.split('/')) {
    if (part === '.' || part === '..') {
      failBatch('attention_batch_path_unsafe', 'root',
        'Attention root must not contain "." or ".." segments.');
    }
  }
  return value;
}

function assertSafeChildName(name, field) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') {
    failBatch('attention_batch_foreign_entry', field,
      'Attention directory entry is not an allowed name.');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')
    || path.basename(name) !== name) {
    failBatch('attention_batch_path_unsafe', field,
      'Attention names must be single path components.');
  }
  if (utf8ByteLength(name) > MAX_ATTENTION_FILENAME_BYTES) {
    failBatch('attention_batch_foreign_entry', field,
      'Attention filename exceeds the bounded length.');
  }
  return name;
}

function childPath(rootPath, name) {
  const safe = assertSafeChildName(name, 'name');
  const joined = path.join(rootPath, safe);
  if (path.dirname(joined) !== rootPath || path.basename(joined) !== safe) {
    failBatch('attention_batch_path_unsafe', 'name',
      'Attention child path escaped the private root.');
  }
  return joined;
}

function ownerUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : undefined;
}

function sameIdentity(left, right) {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

function assertPrivateDirectory(stat, field, label) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    failBatch('attention_batch_root_unsafe', field,
      `The attention ${label} must be a real directory.`);
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failBatch('attention_batch_root_unsafe', field,
      `The attention ${label} must be owned by the current user.`);
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failBatch('attention_batch_root_unsafe', field,
      `The attention ${label} must be private (no group or other access).`);
  }
}

function assertRegularUnsharedFile(stat, field) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    failBatch('attention_batch_not_regular', field,
      'Attention files must be regular non-symlink files.');
  }
  if (!NUMBER_IS_SAFE_INTEGER(stat.nlink) || stat.nlink !== 1) {
    failBatch('attention_batch_not_regular', field,
      'Attention files must not be hardlinked.');
  }
  const uid = ownerUid();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    failBatch('attention_batch_root_unsafe', field,
      'Attention files must be owned by the current user.');
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    failBatch('attention_batch_root_unsafe', field,
      'Attention files must be owner-only.');
  }
}

function expectedReplyCapability(provider) {
  return provider === 'dsh' || provider === 'cursor-cloud'
    ? 'unsupported'
    : 'same_session';
}

function domainDigest(label, value) {
  const canonical = canonicalJsonStringify(value);
  const digest = CREATE_HASH(HASH_ALGORITHM)
    .update(ATTENTION_BATCH_HASH_DOMAIN, 'utf8')
    .update('\n', 'utf8')
    .update(STRING(ATTENTION_BATCH_VERSION), 'utf8')
    .update('\n', 'utf8')
    .update(label, 'utf8')
    .update('\n', 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function itemIdentity(item) {
  return {
    assignment_id: item.assignment_id,
    deadline_at: item.deadline_at,
    event_cursor: item.event_cursor,
    options: item.options,
    prompt: item.prompt,
    provider: item.provider,
    question_id: item.question_id,
    reply_capability: item.reply_capability,
    required: item.required,
    session_id: item.session_id,
    task_id: item.task_id,
  };
}

export function attentionQuestionDigestV1(item) {
  return domainDigest('question', itemIdentity(item));
}

export function deriveAttentionBatchIdV1(runId, source, items) {
  const digest = domainDigest('batch', {
    items: items.map((item) => itemIdentity(item)),
    run_id: runId,
    source,
  });
  return `att-${digest.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function assertPatternedId(value, pattern, path, label) {
  if (typeof value !== 'string' || !capturedTest(pattern, value)) {
    failBatch('invalid_format', path, `${path} must be a valid ${label}.`);
  }
  return value;
}

function assertAssignment(value, path) {
  if (!isAssignmentId(value) || !capturedTest(ASSIGNMENT_ID_PATTERN, value)) {
    failBatch('invalid_format', path,
      `${path} must match ${ASSIGNMENT_ID_PATTERN.source}.`);
  }
  return value;
}

function assertDeadline(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || !capturedTest(DEADLINE_PATTERN, value)) {
    failBatch('invalid_format', path,
      `${path} must be null or an RFC3339 UTC timestamp.`);
  }
  return value;
}

function assertPrompt(value, path) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    failBatch('invalid_format', path,
      `${path} must be null or non-empty sanitized UTF-8.`);
  }
  if (capturedUtf8ByteLength(value) > MAX_ATTENTION_PROMPT_BYTES) {
    failBatch('out_of_range', path,
      `${path} must not exceed ${MAX_ATTENTION_PROMPT_BYTES} bytes.`);
  }
  return value;
}

function assertOptions(value, path) {
  if (value === null) return null;
  assertNotProxy(value, path);
  if (!capturedIsArray(value)) {
    failBatch('invalid_type', path, `${path} must be null or a dense options array.`);
  }
  if (value.length === 0 || value.length > MAX_ATTENTION_OPTIONS) {
    failBatch('out_of_range', path,
      `${path} must carry 1-${MAX_ATTENTION_OPTIONS} options.`);
  }
  const options = [];
  for (let index = 0; index < value.length; index += 1) {
    const optionPath = `${path}[${index}]`;
    const option = ownDataValue(value, STRING(index), optionPath);
    if (typeof option === 'string') {
      if (option.length === 0 || capturedUtf8ByteLength(option) > MAX_ATTENTION_OPTION_BYTES) {
        failBatch('invalid_format', optionPath,
          `${optionPath} must be a bounded non-empty option string.`);
      }
      options.push(option);
      continue;
    }
    const fields = closedObject(
      option, optionPath, ATTENTION_BATCH_OPTION_KEYS, ATTENTION_BATCH_OPTION_REQUIRED_KEYS,
    );
    const normalized = capturedCreate(null);
    for (const key of ATTENTION_BATCH_OPTION_KEYS) {
      if (!capturedHasOwn(fields, key)) continue;
      const text = fields[key];
      if (typeof text !== 'string' || text.length === 0
        || capturedUtf8ByteLength(text) > MAX_ATTENTION_OPTION_BYTES) {
        failBatch('invalid_format', `${optionPath}.${key}`,
          `${optionPath}.${key} must be bounded non-empty option text.`);
      }
      normalized[key] = text;
    }
    if (typeof normalized.kind !== 'string') {
      failBatch('invalid_format', optionPath,
        `${optionPath}.kind is required for a structured option.`);
    }
    options.push(normalized);
  }
  return options;
}

function assertBoolean(value, path) {
  if (value !== true && value !== false) {
    failBatch('invalid_type', path, `${path} must be an exact boolean.`);
  }
  return value;
}

function assertSafeInt(value, path, min, max) {
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value)
    || value < min || value > max) {
    failBatch('invalid_format', path,
      `${path} must be a safe integer between ${min} and ${max}.`);
  }
  return value;
}

function sortByAssignmentId(left, right) {
  if (left.assignment_id < right.assignment_id) return -1;
  if (left.assignment_id > right.assignment_id) return 1;
  return 0;
}

function assertTaskCursor(value, path) {
  const fields = closedObject(value, path, ATTENTION_BATCH_TASK_CURSOR_KEYS);
  return {
    assignment_id: assertAssignment(fields.assignment_id, `${path}.assignment_id`),
    task_id: assertPatternedId(fields.task_id, TASK_ID_PATTERN, `${path}.task_id`, 'task_id'),
    event_cursor: assertPatternedId(
      fields.event_cursor, EVENT_CURSOR_PATTERN, `${path}.event_cursor`, 'event_cursor',
    ),
  };
}

export function validateAttentionSourceV1(source, path = 'source') {
  const fields = closedObject(source, path, ATTENTION_BATCH_SOURCE_KEYS);
  const journalRevision = assertSafeInt(
    fields.journal_revision, `${path}.journal_revision`, 0, 512,
  );
  const head = fields.journal_head_hash;
  if (typeof head !== 'string'
    || (head !== RUN_JOURNAL_GENESIS_PREV && !capturedTest(SHA256_DIGEST_PATTERN, head))) {
    failBatch('invalid_format', `${path}.journal_head_hash`,
      `${path}.journal_head_hash must be the P25 genesis marker or a sha256 digest.`);
  }
  assertNotProxy(fields.task_cursors, `${path}.task_cursors`);
  if (!capturedIsArray(fields.task_cursors)) {
    failBatch('invalid_type', `${path}.task_cursors`,
      `${path}.task_cursors must be a dense array.`);
  }
  if (fields.task_cursors.length < MIN_ATTENTION_ITEMS
    || fields.task_cursors.length > MAX_ATTENTION_ITEMS) {
    failBatch('out_of_range', `${path}.task_cursors`,
      `${path}.task_cursors must carry ${MIN_ATTENTION_ITEMS}..${MAX_ATTENTION_ITEMS} entries.`);
  }
  const cursors = [];
  const seen = new Set();
  for (let index = 0; index < fields.task_cursors.length; index += 1) {
    const cursor = assertTaskCursor(
      ownDataValue(fields.task_cursors, STRING(index), `${path}.task_cursors[${index}]`),
      `${path}.task_cursors[${index}]`,
    );
    if (seen.has(cursor.assignment_id)) {
      failBatch('duplicate_assignment_id', `${path}.task_cursors[${index}].assignment_id`,
        'task_cursors must be unique by assignment_id.');
    }
    seen.add(cursor.assignment_id);
    cursors.push(cursor);
  }
  cursors.sort(sortByAssignmentId);
  return {
    journal_revision: journalRevision,
    journal_head_hash: head,
    task_cursors: cursors,
  };
}

function validateItemShape(value, path) {
  const fields = closedObject(value, path, ATTENTION_BATCH_ITEM_KEYS);
  const provider = fields.provider;
  if (!isKnownProvider(provider) || !capturedIncludes(ATTENTION_BATCH_PROVIDERS, provider)) {
    failBatch('invalid_format', `${path}.provider`,
      `${path}.provider must be exactly one of ${knownProvidersJoined()}.`);
  }
  const replyCapability = fields.reply_capability;
  if (!capturedIncludes(ATTENTION_BATCH_REPLY_CAPABILITIES, replyCapability)) {
    failBatch('invalid_format', `${path}.reply_capability`,
      `${path}.reply_capability must be exactly one of ${capturedJoin(ATTENTION_BATCH_REPLY_CAPABILITIES, ', ')}.`);
  }
  const expected = expectedReplyCapability(provider);
  if (replyCapability !== expected) {
    failBatch('capability_reply_mismatch', `${path}.reply_capability`,
      `${path}.reply_capability must be "${expected}" for provider "${provider}".`);
  }
  if (!capturedIncludes(ATTENTION_BATCH_DISPOSITIONS, fields.disposition)) {
    failBatch('invalid_format', `${path}.disposition`,
      `${path}.disposition must be a closed attention disposition.`);
  }
  const item = {
    assignment_id: assertAssignment(fields.assignment_id, `${path}.assignment_id`),
    task_id: assertPatternedId(fields.task_id, TASK_ID_PATTERN, `${path}.task_id`, 'task_id'),
    provider,
    required: assertBoolean(fields.required, `${path}.required`),
    session_id: assertPatternedId(
      fields.session_id, SESSION_ID_PATTERN, `${path}.session_id`, 'session_id',
    ),
    question_id: assertPatternedId(
      fields.question_id, QUESTION_ID_PATTERN, `${path}.question_id`, 'question_id',
    ),
    event_cursor: assertPatternedId(
      fields.event_cursor, EVENT_CURSOR_PATTERN, `${path}.event_cursor`, 'event_cursor',
    ),
    question_digest: fields.question_digest,
    prompt: assertPrompt(fields.prompt, `${path}.prompt`),
    options: assertOptions(fields.options, `${path}.options`),
    reply_capability: replyCapability,
    disposition: fields.disposition,
    deadline_at: assertDeadline(fields.deadline_at, `${path}.deadline_at`),
  };
  if (typeof item.question_digest !== 'string'
    || !capturedTest(SHA256_DIGEST_PATTERN, item.question_digest)) {
    failBatch('invalid_format', `${path}.question_digest`,
      `${path}.question_digest must be a sha256 digest.`);
  }
  const digest = attentionQuestionDigestV1(item);
  if (digest !== item.question_digest) {
    failBatch('attention_batch_identity_mismatch', `${path}.question_digest`,
      'question_digest must match the latched question identity.');
  }
  return item;
}

function bindItemsToSource(items, source, path) {
  if (items.length !== source.task_cursors.length) {
    failBatch('attention_batch_identity_mismatch', path,
      'Attention items must match the latched P25 cursor boundary.');
  }
  const byAssignment = capturedCreate(null);
  for (const cursor of source.task_cursors) {
    byAssignment[cursor.assignment_id] = cursor;
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const cursor = byAssignment[item.assignment_id];
    if (cursor === undefined) {
      failBatch('attention_batch_identity_mismatch', `${path}[${index}].assignment_id`,
        'Each item must appear on the latched task_cursors boundary.');
    }
    if (cursor.task_id !== item.task_id || cursor.event_cursor !== item.event_cursor) {
      failBatch('attention_batch_identity_mismatch', `${path}[${index}].event_cursor`,
        'Item task_id and event_cursor must equal the latched cursor boundary.');
    }
  }
}

export function validateAttentionItemsV1(items, path = 'items') {
  assertNotProxy(items, path);
  if (!capturedIsArray(items)) {
    failBatch('invalid_type', path, `${path} must be a dense attention item array.`);
  }
  if (items.length < MIN_ATTENTION_ITEMS || items.length > MAX_ATTENTION_ITEMS) {
    failBatch('out_of_range', path,
      `${path} must carry ${MIN_ATTENTION_ITEMS}..${MAX_ATTENTION_ITEMS} unique items.`);
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = validateItemShape(
      ownDataValue(items, STRING(index), `${path}[${index}]`),
      `${path}[${index}]`,
    );
    if (seen.has(item.assignment_id)) {
      failBatch('duplicate_assignment_id', `${path}[${index}].assignment_id`,
        'Attention items must be unique by assignment_id.');
    }
    seen.add(item.assignment_id);
    normalized.push(item);
  }
  normalized.sort(sortByAssignmentId);
  return normalized;
}

function assertResponse(value, path) {
  if (typeof value !== 'string') {
    failBatch('invalid_type', path, `${path} must be a UTF-8 string.`);
  }
  if (capturedUtf8ByteLength(value) > MAX_ATTENTION_RESPONSE_BYTES) {
    failBatch('out_of_range', path,
      `${path} must not exceed ${MAX_ATTENTION_RESPONSE_BYTES} bytes.`);
  }
  return value;
}

function validateReplyValue(reply, batchId, path = 'reply') {
  const fields = closedObject(reply, path, ATTENTION_BATCH_REPLY_KEYS);
  if (fields.batch_id !== batchId) {
    failBatch('attention_batch_identity_mismatch', `${path}.batch_id`,
      'Reply batch_id must equal the latched batch identity.');
  }
  if (fields.round !== ATTENTION_REPLY_ROUND) {
    failBatch('invalid_format', `${path}.round`,
      `Reply round must be exactly ${ATTENTION_REPLY_ROUND}.`);
  }
  assertNotProxy(fields.answers, `${path}.answers`);
  if (!capturedIsArray(fields.answers)) {
    failBatch('invalid_type', `${path}.answers`, `${path}.answers must be a dense array.`);
  }
  if (fields.answers.length > MAX_ATTENTION_ITEMS) {
    failBatch('out_of_range', `${path}.answers`,
      `${path}.answers must not exceed ${MAX_ATTENTION_ITEMS} rows.`);
  }
  const answers = [];
  const seen = new Set();
  for (let index = 0; index < fields.answers.length; index += 1) {
    const answerPath = `${path}.answers[${index}]`;
    const row = closedObject(
      ownDataValue(fields.answers, STRING(index), answerPath),
      answerPath,
      ATTENTION_BATCH_ANSWER_KEYS,
    );
    const assignmentId = assertAssignment(row.assignment_id, `${answerPath}.assignment_id`);
    if (seen.has(assignmentId)) {
      failBatch('duplicate_assignment_id', `${answerPath}.assignment_id`,
        'Reply answers must be unique by assignment_id.');
    }
    seen.add(assignmentId);
    answers.push({
      assignment_id: assignmentId,
      task_id: assertPatternedId(row.task_id, TASK_ID_PATTERN, `${answerPath}.task_id`, 'task_id'),
      session_id: assertPatternedId(
        row.session_id, SESSION_ID_PATTERN, `${answerPath}.session_id`, 'session_id',
      ),
      question_id: assertPatternedId(
        row.question_id, QUESTION_ID_PATTERN, `${answerPath}.question_id`, 'question_id',
      ),
      response: assertResponse(row.response, `${answerPath}.response`),
    });
  }
  answers.sort(sortByAssignmentId);
  return { batch_id: batchId, round: ATTENTION_REPLY_ROUND, answers };
}

function validateUnresolvedEntry(value, path) {
  const fields = closedObject(value, path, ATTENTION_BATCH_UNRESOLVED_KEYS);
  if (!capturedIncludes(ATTENTION_BATCH_UNRESOLVED_CODES, fields.code)) {
    failBatch('invalid_format', `${path}.code`,
      `${path}.code must be a frozen unresolved attention code.`);
  }
  return {
    assignment_id: assertAssignment(fields.assignment_id, `${path}.assignment_id`),
    task_id: assertPatternedId(fields.task_id, TASK_ID_PATTERN, `${path}.task_id`, 'task_id'),
    session_id: assertPatternedId(
      fields.session_id, SESSION_ID_PATTERN, `${path}.session_id`, 'session_id',
    ),
    question_id: assertPatternedId(
      fields.question_id, QUESTION_ID_PATTERN, `${path}.question_id`, 'question_id',
    ),
    required: assertBoolean(fields.required, `${path}.required`),
    code: fields.code,
  };
}

function normalizeUnresolved(entries, path = 'unresolved') {
  assertNotProxy(entries, path);
  if (!capturedIsArray(entries)) {
    failBatch('invalid_type', path, `${path} must be a dense unresolved array.`);
  }
  if (entries.length > MAX_ATTENTION_ITEMS * 2) {
    failBatch('out_of_range', path, `${path} exceeds the bounded unresolved set.`);
  }
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = validateUnresolvedEntry(
      ownDataValue(entries, STRING(index), `${path}[${index}]`),
      `${path}[${index}]`,
    );
    const key = `${entry.assignment_id}\u0000${entry.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  normalized.sort((left, right) => {
    const byAssignment = sortByAssignmentId(left, right);
    if (byAssignment !== 0) return byAssignment;
    if (left.code < right.code) return -1;
    if (left.code > right.code) return 1;
    return 0;
  });
  return normalized;
}

function pushUnresolved(list, item, code) {
  const next = [...list, {
    assignment_id: item.assignment_id,
    task_id: item.task_id,
    session_id: item.session_id,
    question_id: item.question_id,
    required: item.required === true,
    code,
  }];
  return normalizeUnresolved(next, 'unresolved');
}

function identicalQuestionSet(leftItems, rightItems) {
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    if (canonicalJsonStringify(itemIdentity(leftItems[index]))
      !== canonicalJsonStringify(itemIdentity(rightItems[index]))) {
      return false;
    }
  }
  return true;
}

function identicalSource(left, right) {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function deadlineExpired(deadlineAt, now) {
  if (deadlineAt === null || now === undefined) return false;
  const parsed = Date.parse(deadlineAt);
  return NUMBER_IS_SAFE_INTEGER(parsed) && NUMBER_IS_SAFE_INTEGER(now) && now >= parsed;
}

function everySettled(items) {
  return items.every((item) => item.disposition === 'answered' || item.disposition === 'unresolved');
}

function completeCandidateBlocked(items, unresolved) {
  for (const item of items) {
    if (item.required === true && item.disposition === 'unresolved') return true;
  }
  for (const entry of unresolved) {
    if (entry.required === true) return true;
  }
  return false;
}

function encodeRecord(record) {
  const canonical = `${canonicalJsonStringify(record)}\n`;
  const bytes = BUFFER_FROM(canonical, 'utf8');
  if (bytes.byteLength > MAX_ATTENTION_BATCH_RECORD_BYTES) {
    failBatch('attention_batch_record_too_large', 'record',
      `Attention records must not exceed ${MAX_ATTENTION_BATCH_RECORD_BYTES} bytes.`);
  }
  return { record: snapshotRecord(record), bytes };
}

export function validateAttentionBatchRecordV1(record, path = 'record') {
  const fields = closedObject(record, path, ATTENTION_BATCH_RECORD_KEYS);
  if (fields.schema !== ATTENTION_BATCH_SCHEMA_ID) {
    failBatch('invalid_format', `${path}.schema`,
      `${path}.schema must be exactly "${ATTENTION_BATCH_SCHEMA_ID}".`);
  }
  if (fields.version !== ATTENTION_BATCH_VERSION) {
    failBatch('invalid_format', `${path}.version`,
      `${path}.version must be exactly ${ATTENTION_BATCH_VERSION}.`);
  }
  assertRunId(fields.run_id, `${path}.run_id`);
  assertPatternedId(fields.batch_id, BATCH_ID_PATTERN, `${path}.batch_id`, 'batch_id');
  const revision = assertSafeInt(fields.revision, `${path}.revision`, 1, 4096);
  if (!capturedIncludes(ATTENTION_BATCH_STATUSES, fields.status)) {
    failBatch('invalid_format', `${path}.status`,
      `${path}.status must be one of ${capturedJoin(ATTENTION_BATCH_STATUSES, ', ')}.`);
  }
  const source = validateAttentionSourceV1(fields.source, `${path}.source`);
  const items = validateAttentionItemsV1(fields.items, `${path}.items`);
  bindItemsToSource(items, source, `${path}.items`);
  const expectedId = deriveAttentionBatchIdV1(fields.run_id, source, items);
  if (expectedId !== fields.batch_id) {
    failBatch('attention_batch_identity_mismatch', `${path}.batch_id`,
      'batch_id must match the latched run/source/item identity.');
  }
  let reply = fields.reply;
  if (reply === null) {
    if (fields.status !== 'open') {
      failBatch('invalid_format', `${path}.reply`,
        'A non-open attention batch must carry the durable reply round.');
    }
  } else {
    reply = validateReplyValue(reply, fields.batch_id, `${path}.reply`);
    if (fields.status === 'open') {
      failBatch('invalid_format', `${path}.reply`,
        'An open attention batch must not carry a reply.');
    }
  }
  const unresolved = normalizeUnresolved(fields.unresolved, `${path}.unresolved`);
  if (fields.status === 'resolved' && !everySettled(items)) {
    failBatch('invalid_format', `${path}.status`,
      'resolved requires every item to be answered or unresolved.');
  }
  return {
    schema: ATTENTION_BATCH_SCHEMA_ID,
    version: ATTENTION_BATCH_VERSION,
    run_id: fields.run_id,
    batch_id: fields.batch_id,
    revision,
    status: fields.status,
    source,
    items,
    reply,
    unresolved,
  };
}

function receiptFor(record, created) {
  return snapshotRecord({
    schema: ATTENTION_BATCH_RECEIPT_SCHEMA_ID,
    created: created === true,
    complete_candidate_blocked: completeCandidateBlocked(record.items, record.unresolved),
    wake: false,
    remote_mutated: false,
    record,
  });
}

async function openDirectoryHandle(dirPath, field) {
  let handle;
  try {
    handle = await open(dirPath, ROOT_OPEN_FLAGS);
  } catch (error) {
    mapErrno(error, field, 'attention_batch_root_unsafe',
      'The attention directory could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    assertPrivateDirectory(stat, field, 'directory');
    return { handle, path: dirPath, dev: stat.dev, ino: stat.ino, mode: stat.mode };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function reopenAndVerify(token, label) {
  const opened = await openDirectoryHandle(token.path, label);
  try {
    if (!sameIdentity(opened, token)) {
      failBatch('attention_batch_root_unsafe', label,
        `The attention ${label} was replaced during use.`);
    }
    return opened;
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EINVAL' || error?.code === 'ENOTSUP') return;
    failBatch('attention_batch_io_failed', 'directory',
      'The attention directory could not be synchronized.');
  }
}

async function enumerateDirectory(token, maxEntries, field) {
  let dir;
  try {
    dir = await opendir(token.path, { bufferSize: 16 });
  } catch (error) {
    mapErrno(error, field, 'attention_batch_io_failed',
      'The attention directory could not be enumerated.');
  }
  const names = [];
  try {
    let count = 0;
    while (true) {
      const entry = await dir.read();
      if (entry === null) break;
      count += 1;
      if (count > maxEntries) {
        failBatch('attention_batch_too_many_entries', field,
          `Attention directories must not exceed ${maxEntries} entries.`);
      }
      if (entry.name === '.' || entry.name === '..') continue;
      names.push(assertSafeChildName(entry.name, field));
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return names;
}

function classifyRunEntry(name) {
  if (capturedTest(TEMP_NAME_PATTERN, name)) return 'temp';
  if (name === RECORD_NAME) return 'record';
  if (capturedIncludes(P25_FOREIGN_NAMES, name)) return 'p25';
  return 'foreign';
}

async function inspectChildFile(dirToken, name, field) {
  const target = childPath(dirToken.path, name);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failBatch('attention_batch_not_regular', field,
        'Attention entries must be regular non-symlink files.');
    }
    mapErrno(error, field, 'attention_batch_io_failed',
      'The attention entry could not be inspected.');
  }
  try {
    const stat = await handle.stat();
    if (stat.isSymbolicLink() || !stat.isFile()) {
      failBatch('attention_batch_not_regular', field,
        'Attention entries must be regular non-symlink files.');
    }
    return { kind: 'file', stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readBoundedFile(dirToken, name, maxBytes, field) {
  const target = childPath(dirToken.path, name);
  let handle;
  try {
    handle = await open(target, FILE_READ_FLAGS);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      failBatch('attention_batch_not_regular', field,
        'Attention files must be regular non-symlink files.');
    }
    mapErrno(error, field, 'attention_batch_io_failed',
      'The attention file could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) > maxBytes) {
      failBatch('attention_batch_record_too_large', field,
        `Attention files must not exceed ${maxBytes} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      failBatch('attention_batch_record_too_large', field,
        `Attention files must not exceed ${maxBytes} bytes.`);
    }
    const after = await handle.stat();
    if (!sameIdentity(stat, after) || Number(after.size) !== Number(stat.size)
      || Number(after.nlink) !== Number(stat.nlink)) {
      failBatch('attention_batch_io_failed', field,
        'The attention file changed while it was read.');
    }
    return { bytes, stat };
  } finally {
    await handle.close().catch(() => {});
  }
}

function decodeRecordBytes(bytes, field) {
  let text;
  try {
    text = TEXT_DECODER.decode(bytes);
  } catch {
    failBatch('invalid_format', field, 'Attention records must be well-formed UTF-8 JSON.');
  }
  if (!text.endsWith('\n')) {
    failBatch('invalid_format', field, 'Attention records must end with a newline.');
  }
  let parsed;
  try {
    parsed = JSON_PARSE(text);
  } catch {
    failBatch('invalid_format', field, 'Attention records must be valid JSON.');
  }
  const record = validateAttentionBatchRecordV1(parsed, field);
  const encoded = encodeRecord(record);
  if (encoded.bytes.byteLength !== bytes.byteLength
    || !TIMING_SAFE_EQUAL(encoded.bytes, bytes)) {
    failBatch('attention_batch_identity_mismatch', field,
      'Stored attention bytes do not match the canonical record.');
  }
  return encoded.record;
}

async function atomicPublish(dirToken, finalName, bytes, field) {
  const tempName = `.tmp-${RANDOM_BYTES(16).toString('hex')}`;
  const tempPath = childPath(dirToken.path, tempName);
  const finalPath = childPath(dirToken.path, finalName);
  let handle;
  try {
    handle = await open(tempPath, FILE_CREATE_FLAGS, 0o600);
  } catch (error) {
    mapErrno(error, field, 'attention_batch_io_failed',
      'A private temporary file could not be created.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) !== bytes.byteLength) {
      failBatch('attention_batch_io_failed', field, 'Temporary write was truncated.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    mapErrno(error, field, 'attention_batch_io_failed',
      'The attention record could not be published atomically.');
  }
  await syncDirectory(dirToken.handle);
}

async function exclusivePublish(dirToken, finalName, bytes, field) {
  const tempName = `.tmp-${RANDOM_BYTES(16).toString('hex')}`;
  const tempPath = childPath(dirToken.path, tempName);
  const finalPath = childPath(dirToken.path, finalName);
  let handle;
  try {
    handle = await open(tempPath, FILE_CREATE_FLAGS, 0o600);
  } catch (error) {
    mapErrno(error, field, 'attention_batch_io_failed',
      'A private temporary file could not be created.');
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    assertRegularUnsharedFile(stat, field);
    if (Number(stat.size) !== bytes.byteLength) {
      failBatch('attention_batch_io_failed', field, 'Temporary write was truncated.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    await link(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    if (error?.code === 'EEXIST') return false;
    mapErrno(error, field, 'attention_batch_io_failed',
      'The attention record could not be published exclusively.');
  }
  await unlink(tempPath).catch(() => {});
  await syncDirectory(dirToken.handle);
  return true;
}

async function removeStaleTemporaries(dirToken, names) {
  let removed = 0;
  for (const name of names) {
    if (!capturedTest(TEMP_NAME_PATTERN, name)) continue;
    const target = childPath(dirToken.path, name);
    let handle;
    try {
      handle = await open(target, FILE_READ_FLAGS);
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
        failBatch('attention_batch_not_regular', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (stat.isSymbolicLink() || !stat.isFile()) {
        failBatch('attention_batch_not_regular', 'temporary',
          'A leftover temporary path is not a regular file and was not followed.');
      }
      const uid = ownerUid();
      if (uid !== undefined && Number(stat.uid) !== uid) {
        failBatch('attention_batch_root_unsafe', 'temporary',
          'A leftover temporary file is not owned by the current user.');
      }
    } finally {
      await handle.close().catch(() => {});
    }
    try {
      await unlink(target);
      removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (removed > 0) await syncDirectory(dirToken.handle);
  return removed;
}

async function ensurePrivateDirectory(parentToken, name, field) {
  const target = childPath(parentToken.path, name);
  try {
    await mkdir(target, { mode: 0o700 });
    await syncDirectory(parentToken.handle);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      mapErrno(error, field, 'attention_batch_io_failed',
        'The attention directory could not be created.');
    }
  }
  const opened = await openDirectoryHandle(target, field);
  try {
    await opened.handle.chmod(0o700);
  } catch {
    // chmod after umask; verification below is authoritative.
  }
  await opened.handle.close().catch(() => {});
  return openDirectoryHandle(target, field);
}

async function auditRunDirectory(dirToken) {
  const names = await enumerateDirectory(dirToken, MAX_ATTENTION_DIRECTORY_ENTRIES, 'directory');
  const temps = [];
  let hasRecord = false;
  for (const name of names) {
    const kind = classifyRunEntry(name);
    if (kind === 'p25') {
      failBatch('attention_batch_root_shared', 'directory',
        'The attention root must stay separate from accepted P25 journal files.');
    }
    if (kind === 'foreign') {
      failBatch('attention_batch_foreign_entry', 'directory',
        'The attention run directory contains a foreign entry.');
    }
    if (kind === 'temp') {
      temps.push(name);
      if (temps.length > MAX_ATTENTION_BATCH_TEMPORARIES) {
        failBatch('attention_batch_too_many_entries', 'temporary',
          'Attention run directories exceed the leftover temporary bound.');
      }
      continue;
    }
    hasRecord = true;
    const inspection = await inspectChildFile(dirToken, name, 'record');
    if (inspection.kind !== 'file') {
      failBatch('attention_batch_not_regular', 'record',
        'Attention records must be regular non-symlink files.');
    }
    assertRegularUnsharedFile(inspection.stat, 'record');
  }
  return { names, temps, hasRecord };
}

async function readRecord(dirToken, runId) {
  const opened = await readBoundedFile(
    dirToken, RECORD_NAME, MAX_ATTENTION_BATCH_RECORD_BYTES, 'record',
  );
  if (opened === null) return null;
  const record = decodeRecordBytes(opened.bytes, 'record');
  if (record.run_id !== runId) {
    failBatch('attention_batch_identity_mismatch', 'run_id',
      'The stored attention record does not match the requested run identity.');
  }
  return record;
}

async function publishRecord(dirToken, record, exclusive = false) {
  const encoded = encodeRecord(validateAttentionBatchRecordV1(record));
  if (exclusive) {
    const created = await exclusivePublish(dirToken, RECORD_NAME, encoded.bytes, 'record');
    if (!created) return null;
  } else {
    await atomicPublish(dirToken, RECORD_NAME, encoded.bytes, 'record');
  }
  const reread = await readBoundedFile(
    dirToken, RECORD_NAME, MAX_ATTENTION_BATCH_RECORD_BYTES, 'record',
  );
  if (reread === null || !TIMING_SAFE_EQUAL(reread.bytes, encoded.bytes)) {
    failBatch('attention_batch_publish_unverified', 'record',
      'The published attention record did not verify.');
  }
  return encoded.record;
}

function withRootChain(token, operation) {
  const id = `${STRING(token.dev)}:${STRING(token.ino)}`;
  const previous = ROOT_CHAINS.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const settled = current.catch(() => {}).then(() => {
    if (ROOT_CHAINS.get(id) === settled) ROOT_CHAINS.delete(id);
  });
  ROOT_CHAINS.set(id, settled);
  return current;
}

function parseNow(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !NUMBER_IS_SAFE_INTEGER(value) || value < 0) {
    failBatch('invalid_format', 'now', 'now must be a non-negative epoch millisecond.');
  }
  return value;
}

function parseInjectedFunction(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'function') {
    failBatch('invalid_type', field, `${field} must be an injected function.`);
  }
  return value;
}

function parseOperationOptions(options, allowed, required, path = '$') {
  if (options === undefined || options === null || typeof options !== 'object'
    || capturedIsArray(options)) {
    failBatch('invalid_type', path, 'Attention options must be a plain object.');
  }
  assertNotProxy(options, path);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'symbol') {
      failBatch('symbol_key_denied', `${path}[symbol]`,
        'Attention options carry a symbol-keyed property.');
    }
  }
  for (const key of sortedCapturedKeys(options)) {
    if (!capturedIncludes(allowed, key)) {
      failBatch('unknown_key', `${path}.${key}`,
        `${path}.${key} is not a closed attention option.`);
    }
  }
  for (const key of required) {
    if (!capturedHasOwn(options, key)) {
      failBatch('missing_key', `${path}.${key}`, `${path}.${key} is required.`);
    }
  }
  const json = {};
  const injected = {};
  for (const key of allowed) {
    if (!capturedHasOwn(options, key)) continue;
    const value = ownDataValue(options, key, `${path}.${key}`);
    if (capturedIncludes(FUNCTION_KEYS, key) || key === 'now') {
      if (key === 'now') injected.now = parseNow(value);
      else injected[key] = parseInjectedFunction(value, `${path}.${key}`);
      continue;
    }
    assertDirectJsonClosure(value, `${path}.${key}`);
    json[key] = value;
  }
  return { json, injected };
}

async function invokeCancel(cancel, identity, _code) {
  if (typeof cancel !== 'function') return 'unconfirmed';
  let result;
  try {
    result = await cancel(snapshotRecord({
      run_id: identity.run_id,
      assignment_id: identity.assignment_id,
      task_id: identity.task_id,
      session_id: identity.session_id,
      question_id: identity.question_id,
    }));
  } catch {
    return 'unconfirmed';
  }
  if (result === undefined || result === null || typeof result !== 'object'
    || capturedIsArray(result)) {
    return 'unconfirmed';
  }
  if (!capturedHasOwn(result, 'outcome')) return 'unconfirmed';
  const outcome = ownDataValue(result, 'outcome', 'cancel.outcome');
  if (outcome !== 'confirmed' && outcome !== 'unconfirmed') return 'unconfirmed';
  for (const key of ['run_id', 'assignment_id', 'task_id', 'session_id', 'question_id']) {
    if (capturedHasOwn(result, key) && ownDataValue(result, key, `cancel.${key}`) !== identity[key]) {
      failBatch('attention_batch_identity_mismatch', `cancel.${key}`,
        'Cancel may retry only the exact latched lane identity.');
    }
  }
  return outcome;
}

async function invokeDeliver(deliver, identity) {
  if (typeof deliver !== 'function') {
    failBatch('invalid_type', 'deliver',
      'Same-session delivery requires an injected deliver function.');
  }
  let result;
  try {
    result = await deliver(snapshotRecord({
      run_id: identity.run_id,
      assignment_id: identity.assignment_id,
      task_id: identity.task_id,
      session_id: identity.session_id,
      question_id: identity.question_id,
      response: identity.response,
    }));
  } catch {
    return 'failed';
  }
  if (result === undefined || result === null || typeof result !== 'object'
    || capturedIsArray(result)) {
    return 'failed';
  }
  for (const key of ['run_id', 'assignment_id', 'task_id', 'session_id', 'question_id']) {
    if (capturedHasOwn(result, key)
      && ownDataValue(result, key, `deliver.${key}`) !== identity[key]) {
      failBatch('attention_batch_identity_mismatch', `deliver.${key}`,
        'Delivery may retry only the exact latched reply identity.');
    }
  }
  const outcome = capturedHasOwn(result, 'outcome')
    ? ownDataValue(result, 'outcome', 'deliver.outcome')
    : undefined;
  if (outcome === 'delivered' || outcome === 'already_delivered') return 'delivered';
  return 'failed';
}

async function cancelAffected(cancel, runId, item, unresolved, code) {
  let next = pushUnresolved(unresolved, item, code);
  const outcome = await invokeCancel(cancel, { run_id: runId, ...item }, code);
  if (outcome !== 'confirmed') {
    next = pushUnresolved(next, item, 'safe_cancel_unconfirmed');
  }
  return next;
}

function applyUnsupportedAndDeadlines(runId, items, unresolved, cancel, now) {
  const nextItems = items.map((item) => ({ ...item }));
  let nextUnresolved = unresolved;
  return (async () => {
    for (const item of nextItems) {
      if (item.reply_capability === 'unsupported') {
        item.disposition = 'unresolved';
        nextUnresolved = await cancelAffected(
          cancel, runId, item, nextUnresolved, 'same_session_reply_unsupported',
        );
        continue;
      }
      if (deadlineExpired(item.deadline_at, now)) {
        item.disposition = 'unresolved';
        nextUnresolved = await cancelAffected(
          cancel, runId, item, nextUnresolved, 'reply_deadline_expired',
        );
      }
    }
    return { items: nextItems, unresolved: nextUnresolved };
  })();
}

async function openRunContext(rootToken, runId, createIfMissing) {
  assertRunId(runId, 'run_id');
  const rootNames = await enumerateDirectory(rootToken, MAX_ATTENTION_ROOT_ENTRIES, 'root');
  for (const name of rootNames) {
    if (name !== RUNS_NAME) {
      failBatch('attention_batch_foreign_entry', 'root',
        'The attention root contains a foreign entry.');
    }
  }
  let runsToken;
  if (!rootNames.includes(RUNS_NAME)) {
    if (!createIfMissing) {
      failBatch('attention_batch_not_found', 'root',
        'The attention root does not contain a runs directory yet.');
    }
    runsToken = await ensurePrivateDirectory(rootToken, RUNS_NAME, 'runs');
  } else {
    runsToken = await openDirectoryHandle(childPath(rootToken.path, RUNS_NAME), 'runs');
  }
  try {
    const runNames = await enumerateDirectory(
      runsToken, MAX_ATTENTION_RUN_DIRECTORIES + 1, 'runs',
    );
    if (runNames.length > MAX_ATTENTION_RUN_DIRECTORIES) {
      failBatch('attention_batch_too_many_entries', 'runs',
        `The attention root must not exceed ${MAX_ATTENTION_RUN_DIRECTORIES} run directories.`);
    }
    for (const name of runNames) {
      assertRunId(name, 'runs');
      const child = await openDirectoryHandle(childPath(runsToken.path, name), 'runs');
      try {
        const audit = await auditRunDirectory(child);
        if (name === runId) {
          await removeStaleTemporaries(child, audit.temps);
        }
      } finally {
        await child.handle.close().catch(() => {});
      }
    }
    if (!runNames.includes(runId)) {
      if (!createIfMissing) {
        failBatch('attention_batch_not_found', 'run_id',
          'No attention batch exists for that run id.');
      }
      const created = await ensurePrivateDirectory(runsToken, runId, 'run_id');
      await created.handle.close().catch(() => {});
    }
    const dirToken = await openDirectoryHandle(childPath(runsToken.path, runId), 'directory');
    try {
      const audit = await auditRunDirectory(dirToken);
      await removeStaleTemporaries(dirToken, audit.temps);
      const record = await readRecord(dirToken, runId);
      return { runsToken, dirToken, record };
    } catch (error) {
      await dirToken.handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    await runsToken.handle.close().catch(() => {});
    throw error;
  }
}

function assertExpectedRevision(expected, current, allowCreateRetry) {
  if (allowCreateRetry && expected === 0 && current >= 1) return;
  if (expected !== current) {
    failBatch('attention_batch_revision_conflict', 'expected_revision',
      'expected_revision does not match the durable attention revision.');
  }
}

async function latchOnHandle(rootToken, options) {
  const parsed = parseOperationOptions(options, LATCH_ALLOWED_KEYS, LATCH_REQUIRED_KEYS);
  assertRunId(parsed.json.run_id, 'run_id');
  const expectedRevision = assertSafeInt(
    parsed.json.expected_revision, 'expected_revision', 0, 4096,
  );
  const source = validateAttentionSourceV1(parsed.json.source, 'source');
  const requestedItems = validateAttentionItemsV1(parsed.json.items, 'items');
  bindItemsToSource(requestedItems, source, 'items');
  const batchId = deriveAttentionBatchIdV1(parsed.json.run_id, source, requestedItems);
  const now = parsed.injected.now;
  const cancel = parsed.injected.cancel;
  const context = await openRunContext(rootToken, parsed.json.run_id, true);
  try {
    const existing = context.record;
    if (existing !== null) {
      if (identicalSource(existing.source, source)
        && identicalQuestionSet(existing.items, requestedItems)
        && existing.batch_id === batchId) {
        assertExpectedRevision(expectedRevision, existing.revision, true);
        return receiptFor(existing, false);
      }
      assertExpectedRevision(expectedRevision, existing.revision, false);
      let unresolved = existing.unresolved;
      for (const item of requestedItems) {
        unresolved = await cancelAffected(
          cancel, parsed.json.run_id, item, unresolved, 'late_attention_after_latch',
        );
      }
      const next = await publishRecord(context.dirToken, {
        ...existing,
        revision: existing.revision + 1,
        unresolved,
      });
      return receiptFor(next, false);
    }
    assertExpectedRevision(expectedRevision, 0, false);
    const preparedItems = requestedItems.map((item) => ({ ...item, disposition: 'pending' }));
    const applied = await applyUnsupportedAndDeadlines(
      parsed.json.run_id, preparedItems, [], cancel, now,
    );
    const record = {
      schema: ATTENTION_BATCH_SCHEMA_ID,
      version: ATTENTION_BATCH_VERSION,
      run_id: parsed.json.run_id,
      batch_id: batchId,
      revision: 1,
      status: 'open',
      source,
      items: applied.items,
      reply: null,
      unresolved: applied.unresolved,
    };
    const published = await publishRecord(context.dirToken, record, true);
    if (published === null) {
      const winner = await readRecord(context.dirToken, parsed.json.run_id);
      if (winner === null) {
        failBatch('attention_batch_io_failed', 'record',
          'The attention record could not be created exclusively.');
      }
      if (identicalSource(winner.source, source)
        && identicalQuestionSet(winner.items, requestedItems)
        && winner.batch_id === batchId) {
        return receiptFor(winner, false);
      }
      failBatch('attention_batch_revision_conflict', 'expected_revision',
        'expected_revision does not match the durable attention revision.');
    }
    return receiptFor(published, true);
  } finally {
    await context.dirToken.handle.close().catch(() => {});
    await context.runsToken.handle.close().catch(() => {});
  }
}

function pendingSameSession(items) {
  return items.filter((item) => item.disposition === 'pending' && item.reply_capability === 'same_session');
}

function bindAnswers(answers, items, runId) {
  const pending = pendingSameSession(items);
  if (answers.length !== pending.length) {
    failBatch('attention_batch_identity_mismatch', 'reply.answers',
      'The one reply round must cover every pending same-session item exactly once.');
  }
  const byAssignment = capturedCreate(null);
  for (const item of pending) byAssignment[item.assignment_id] = item;
  for (const answer of answers) {
    const item = byAssignment[answer.assignment_id];
    if (item === undefined) {
      failBatch('attention_batch_identity_mismatch', 'reply.answers',
        'Reply answers must address only pending same-session identities.');
    }
    if (item.task_id !== answer.task_id
      || item.session_id !== answer.session_id
      || item.question_id !== answer.question_id) {
      failBatch('attention_batch_identity_mismatch', 'reply.answers',
        'Reply answers must retry only the exact latched identities.');
    }
    if (item.run_id !== undefined && item.run_id !== runId) {
      failBatch('attention_batch_identity_mismatch', 'run_id',
        'Reply answers must stay bound to the latched run.');
    }
  }
}

async function deliverPending(existing, deliver, cancel, now, runId) {
  const items = existing.items.map((item) => ({ ...item }));
  let unresolved = existing.unresolved;
  const reply = existing.reply;
  const answers = reply === null ? [] : reply.answers;
  const answerByAssignment = capturedCreate(null);
  for (const answer of answers) answerByAssignment[answer.assignment_id] = answer;
  for (const item of items) {
    if (item.disposition !== 'pending') continue;
    if (deadlineExpired(item.deadline_at, now)) {
      item.disposition = 'unresolved';
      unresolved = await cancelAffected(
        cancel, runId, item, unresolved, 'reply_deadline_expired',
      );
      continue;
    }
    const answer = answerByAssignment[item.assignment_id];
    if (answer === undefined) continue;
    const outcome = await invokeDeliver(deliver, {
      run_id: runId,
      assignment_id: item.assignment_id,
      task_id: item.task_id,
      session_id: item.session_id,
      question_id: item.question_id,
      response: answer.response,
    });
    if (outcome === 'delivered') {
      item.disposition = 'answered';
      continue;
    }
    item.disposition = 'unresolved';
    unresolved = await cancelAffected(
      cancel, runId, item, unresolved, 'reply_delivery_failed',
    );
  }
  const status = everySettled(items) ? 'resolved' : existing.status;
  return { items, unresolved, status };
}

async function replyOnHandle(rootToken, options) {
  const parsed = parseOperationOptions(options, REPLY_ALLOWED_KEYS, REPLY_REQUIRED_KEYS);
  assertRunId(parsed.json.run_id, 'run_id');
  assertPatternedId(parsed.json.batch_id, BATCH_ID_PATTERN, 'batch_id', 'batch_id');
  const expectedRevision = assertSafeInt(
    parsed.json.expected_revision, 'expected_revision', 0, 4096,
  );
  const context = await openRunContext(rootToken, parsed.json.run_id, false);
  try {
    if (context.record === null) {
      failBatch('attention_batch_not_found', 'run_id',
        'No attention batch exists for that run id.');
    }
    const existing = context.record;
    if (existing.batch_id !== parsed.json.batch_id) {
      failBatch('attention_batch_identity_mismatch', 'batch_id',
        'Reply batch_id must equal the latched batch identity.');
    }
    const reply = validateReplyValue(parsed.json.reply, existing.batch_id, 'reply');
    if (existing.reply !== null) {
      if (canonicalJsonStringify(existing.reply) !== canonicalJsonStringify(reply)) {
        failBatch('attention_batch_reply_conflict', 'reply',
          'A different reply round is already durable for this batch.');
      }
      assertExpectedRevision(expectedRevision, existing.revision, false);
      if (existing.status === 'resolved') return receiptFor(existing, false);
      const delivered = await deliverPending(
        existing, parsed.injected.deliver, parsed.injected.cancel, parsed.injected.now,
        parsed.json.run_id,
      );
      const next = await publishRecord(context.dirToken, {
        ...existing,
        revision: existing.revision + 1,
        status: delivered.status,
        items: delivered.items,
        unresolved: delivered.unresolved,
      });
      return receiptFor(next, false);
    }
    assertExpectedRevision(expectedRevision, existing.revision, false);
    bindAnswers(reply.answers, existing.items, parsed.json.run_id);
    const committed = await publishRecord(context.dirToken, {
      ...existing,
      revision: existing.revision + 1,
      status: 'reply_committed',
      reply,
    });
    const delivered = await deliverPending(
      committed, parsed.injected.deliver, parsed.injected.cancel, parsed.injected.now,
      parsed.json.run_id,
    );
    const next = await publishRecord(context.dirToken, {
      ...committed,
      revision: committed.revision + 1,
      status: delivered.status,
      items: delivered.items,
      unresolved: delivered.unresolved,
    });
    return receiptFor(next, true);
  } finally {
    await context.dirToken.handle.close().catch(() => {});
    await context.runsToken.handle.close().catch(() => {});
  }
}

async function getOnHandle(rootToken, runId) {
  assertRunId(runId, 'run_id');
  const context = await openRunContext(rootToken, runId, false);
  try {
    if (context.record === null) {
      failBatch('attention_batch_not_found', 'run_id',
        'No attention batch exists for that run id.');
    }
    return receiptFor(context.record, false);
  } finally {
    await context.dirToken.handle.close().catch(() => {});
    await context.runsToken.handle.close().catch(() => {});
  }
}

export function describeAttentionBatchV1() {
  return freezeData({
    schema: ATTENTION_BATCH_SCHEMA_ID,
    version: ATTENTION_BATCH_VERSION,
    receipt_schema: ATTENTION_BATCH_RECEIPT_SCHEMA_ID,
    record_keys: ATTENTION_BATCH_RECORD_KEYS,
    statuses: ATTENTION_BATCH_STATUSES,
    source_keys: ATTENTION_BATCH_SOURCE_KEYS,
    task_cursor_keys: ATTENTION_BATCH_TASK_CURSOR_KEYS,
    item_keys: ATTENTION_BATCH_ITEM_KEYS,
    providers: ATTENTION_BATCH_PROVIDERS,
    reply_capabilities: ATTENTION_BATCH_REPLY_CAPABILITIES,
    dispositions: ATTENTION_BATCH_DISPOSITIONS,
    unresolved_codes: ATTENTION_BATCH_UNRESOLVED_CODES,
    reply_keys: ATTENTION_BATCH_REPLY_KEYS,
    answer_keys: ATTENTION_BATCH_ANSWER_KEYS,
    unresolved_keys: ATTENTION_BATCH_UNRESOLVED_KEYS,
    error_codes: ATTENTION_BATCH_ERROR_CODES,
    bounds: capturedFreeze({
      items: capturedFreeze({ min: MIN_ATTENTION_ITEMS, max: MAX_ATTENTION_ITEMS }),
      options: MAX_ATTENTION_OPTIONS,
      prompt_bytes: MAX_ATTENTION_PROMPT_BYTES,
      response_bytes: MAX_ATTENTION_RESPONSE_BYTES,
      reply_round: ATTENTION_REPLY_ROUND,
    }),
    storage: capturedFreeze({
      file: `runs/<run_id>/${ATTENTION_BATCH_FILE_NAME}`,
      directories: '0700',
      files: '0600',
      publication: 'same-directory temporary, fsync, atomic rename, directory fsync',
      cas: 'expected_revision',
    }),
    ownership: capturedFreeze({
      p25: 'unchanged six journal facts, hash chain, cursor, and derived state',
      p34: 'attention snapshots, batch identity, one reply commitment, delivery disposition, unresolved evidence, separate atomic persistence',
      forbidden: capturedFreeze([
        'p25_event_kind_change',
        'question_encoding_in_child_progress_note',
        'foreign_p25_journal_files',
        'scheduler',
        'provider_dispatch',
        'candidate_composition',
        'server_tool_wiring',
        'cleanup_implementation',
        'gate_a',
        'release',
      ]),
    }),
    wake: false,
    remote_mutated: false,
  });
}

export async function openAttentionRoot(rootPath) {
  const resolved = assertSafeRootPath(rootPath);
  const opened = await openDirectoryHandle(resolved, 'root');
  const token = capturedFreeze({
    path: opened.path,
    dev: opened.dev,
    ino: opened.ino,
  });
  await opened.handle.close().catch(() => {});
  return capturedFreeze({
    root: token.path,
    async latch(options) {
      return withRootChain(token, async () => {
        const root = await reopenAndVerify(token, 'root');
        try {
          return await latchOnHandle(root, options);
        } finally {
          await root.handle.close().catch(() => {});
        }
      });
    },
    async reply(options) {
      return withRootChain(token, async () => {
        const root = await reopenAndVerify(token, 'root');
        try {
          return await replyOnHandle(root, options);
        } finally {
          await root.handle.close().catch(() => {});
        }
      });
    },
    async get(runId) {
      return withRootChain(token, async () => {
        const root = await reopenAndVerify(token, 'root');
        try {
          return await getOnHandle(root, runId);
        } finally {
          await root.handle.close().catch(() => {});
        }
      });
    },
  });
}

capturedFreeze(openAttentionRoot);
capturedFreeze(describeAttentionBatchV1);
capturedFreeze(validateAttentionBatchRecordV1);
capturedFreeze(validateAttentionSourceV1);
capturedFreeze(validateAttentionItemsV1);
capturedFreeze(attentionQuestionDigestV1);
capturedFreeze(deriveAttentionBatchIdV1);
