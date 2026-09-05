import { sanitizePublicReceipt, redactDiagnosticText } from './diagnostics.mjs';

/** Bounded MCP text fallback for clients that only read content[0].text. */
export const TEXT_FALLBACK_SCHEMA = 'co_engineer.mcp_text_fallback.v1';
export const TEXT_FALLBACK_MAX_BYTES = 2_048;
export const TEXT_FALLBACK_TASK_PREVIEW = 5;
export const RESPONSE_MODE_STRUCTURED = 'structured';

/** UX-04 experience projection: three semantic cards over sanitized run receipts. */
export const EXPERIENCE_SCHEMA = 'codex-co-engineer.experience-projection.v1';
export const EXPERIENCE_VERSION = 1;
export const EXPERIENCE_CARD_STATES = Object.freeze(['run', 'attention', 'final']);
export const EXPERIENCE_MAX_BYTES = 8_192;
export const EXPERIENCE_OBJECTIVE_BYTES = 512;
export const EXPERIENCE_QUESTION_BYTES = 320;
export const EXPERIENCE_SCOPE_PATTERN_BYTES = 96;
export const EXPERIENCE_MAX_LANES = 8;
export const EXPERIENCE_MAX_QUESTIONS = 8;
export const PUBLIC_MCP_TOOLS = Object.freeze([
  'status', 'delegate', 'task', 'tasks', 'cancel',
]);

export const EXPERIENCE_PHRASES = Object.freeze({
  delegating: 'I am delegating this to Co-Engineer',
  preparing_one: 'Co-Engineer is preparing 1 assignment',
  preparing_template: 'Co-Engineer is preparing N assignments',
  running_one: 'Co-Engineer is running 1 independent assignment',
  running_template: 'Co-Engineer is running N independent assignments',
  reconciling: 'Co-Engineer is reconciling an uncertain assignment',
  attention: 'Co-Engineer needs one decision from you',
  verified_final: 'Co-Engineer finished, and I verified the candidate.',
});

export const PROVIDER_DISPLAY = Object.freeze({
  grok: 'Using Grok Co-Engineer',
  'cursor-local': 'Using Cursor Co-Engineer',
  'cursor-cloud': 'Using Cursor Co-Engineer',
  dsh: 'Using Muse Co-Engineer',
});

const PROVIDER_PHRASE_ORDER = Object.freeze([
  'Using Grok Co-Engineer',
  'Using Cursor Co-Engineer',
  'Using Muse Co-Engineer',
]);

export const EXPERIENCE_AUTHORITY = Object.freeze({
  merge: 'codex',
  review: 'codex',
  lifecycle: 'p33',
  attention: 'p34',
  candidate: 'p35',
  truth: 'r-truth',
});

export const EXPERIENCE_COORDINATION = Object.freeze({
  submissions: 1,
  aggregate_wait: 'decision_or_attention',
  aggregate_wait_count: 1,
  verified_final_decisions: 1,
  grouped_reply: 1,
});

// The values above describe the bounded-run contract.  A projection also
// carries observed counts so an in-progress or unsuccessful receipt cannot
// look like it already reached the contract's verified-final outcome.

export const EXPERIENCE_DENIED_CONTROLS = Object.freeze({
  merge: false,
  push: false,
  rebase: false,
  create_pr: false,
});

const OWNER_ONLY_KEYS = Object.freeze([
  'raw', 'bytes', 'secret', 'secrets', 'credential', 'credentials',
  'payload', 'stdout', 'stderr', 'prompt', 'argv', 'env',
  'repository_path', 'worktree_path', 'agent_argv', 'cli_argv',
]);

const SHA40 = /^[a-fA-F0-9]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EVENT_CURSOR = /^[0-9]{1,16}$/u;
const TERMINAL_LANE_STATUSES = Object.freeze([
  'completed', 'failed', 'cancelled', 'unresolved', 'timeout',
  'transport_lost', 'environment_blocked',
]);
const ACCEPTED_LANE_STATUSES = Object.freeze(['completed']);
const FAILED_LANE_STATUSES = Object.freeze([
  'failed', 'timeout', 'transport_lost', 'environment_blocked',
]);
const UNRESOLVED_LANE_STATUSES = Object.freeze([
  'unresolved', 'partial_handoff', 'unrecoverable_post_prompt', 'lifecycle_pending',
]);
const RECONCILIATION_LANE_STATUSES = Object.freeze([
  'partial_handoff', 'unrecoverable_post_prompt', 'lifecycle_pending',
]);
const ACTIVE_LANE_STATUSES = Object.freeze([
  'accepted', 'starting', 'running', 'cancelling', 'dispatched',
  'prompt_dispatched', 'needs_attention', 'session_ready',
]);
const RECONCILIATION_PHASES = Object.freeze([
  'degraded', 'unresolved', 'partial_handoff', 'unrecoverable_post_prompt',
  'lifecycle_pending',
]);
const ATTENTION_OPEN_STATUSES = Object.freeze(['open', 'needs_attention']);
const RUN_LIFECYCLE_PHASES = Object.freeze([
  'validating', 'awaiting_consent', 'preparing_workspaces', 'dispatching',
  'running', 'needs_attention', 'degraded', 'unresolved', 'verifying', 'completed',
  'failed', 'cancelled', 'partial_handoff', 'unrecoverable_post_prompt',
  'lifecycle_pending',
]);
const RUN_NONTERMINAL_PHASES = Object.freeze([
  'validating', 'preparing_workspaces', 'dispatching', 'running', 'verifying',
]);
const KNOWN_EVIDENCE_KINDS = Object.freeze([
  'acceptance_results', 'artifact_integrity', 'command_reported', 'files_changed',
  'git_diff', 'git_identity', 'head_reached', 'head_sha', 'model_attested',
  'model_used', 'tests_passed',
]);
const UNSUPPORTED_REPLY_PROVIDERS = Object.freeze(['dsh', 'cursor-cloud']);
const UNSUPPORTED_REPLY_CODE = 'same_session_reply_unsupported';

/** Modern MCP Apps tool metadata. Never emit the deprecated flat ui/resourceUri key. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const MCP_APPS_URI_SCHEME = 'ui://';
export const MCP_APPS_LEGACY_RESOURCE_URI_META_KEY = 'ui/resourceUri';
export const EXPERIENCE_UI_RESOURCE_URIS = Object.freeze({
  shell: 'ui://codex-co-engineer/experience',
  run: 'ui://codex-co-engineer/experience/run',
  attention: 'ui://codex-co-engineer/experience/attention',
  final: 'ui://codex-co-engineer/experience/final',
});

const LAST_RESORT_NOTE = 'read structuredContent';

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** Smallest last-resort document that still reports text_max_bytes at the default cap. */
const LAST_RESORT_MIN_BYTES = byteLength(JSON.stringify({
  schema: TEXT_FALLBACK_SCHEMA,
  authoritative: 'structuredContent',
  receipt_in_text: false,
  truncated: true,
  text_max_bytes: TEXT_FALLBACK_MAX_BYTES,
  note: LAST_RESORT_NOTE,
}));

function clipText(value, maxChars = 240) {
  const text = redactDiagnosticText(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function taskPreview(task) {
  if (!task || typeof task !== 'object') return null;
  // Wait-any entries wrap the compact task snapshot so the outer envelope can
  // retain its task_id, fresh progress, wake state, and per-target error.
  const wrappedTask = task.task && typeof task.task === 'object' ? task.task : null;
  const source = wrappedTask ?? task;
  return {
    id: typeof task.task_id === 'string'
      ? task.task_id
      : (typeof source.id === 'string' ? source.id : (typeof source.task_id === 'string' ? source.task_id : null)),
    status: typeof source.status === 'string' ? source.status : null,
    state: typeof task.state === 'string'
      ? task.state
      : (typeof source.state === 'string' ? source.state : null),
    provider: typeof source.provider === 'string' ? source.provider : null,
  };
}

/**
 * Deterministic coordination summary for text-only MCP clients.
 * structuredContent remains the authoritative full receipt.
 */
export function summarizeStructuredContent(safe) {
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) {
    return { kind: 'opaque' };
  }
  if (safe.error && typeof safe.error === 'object') {
    return {
      kind: 'error',
      error: {
        code: typeof safe.error.code === 'string' ? safe.error.code : null,
        message: clipText(safe.error.message, 320),
      },
    };
  }
  if (Array.isArray(safe.tasks) && typeof safe.version === 'string') {
    return {
      kind: 'status',
      version: safe.version,
      healthy: safe.healthy === true,
      active: Number.isFinite(safe.active) ? safe.active : null,
      providers: Array.isArray(safe.providers) ? safe.providers.slice(0, 8) : [],
      task_count: safe.tasks.length,
      tasks: safe.tasks.slice(0, TEXT_FALLBACK_TASK_PREVIEW).map(taskPreview).filter(Boolean),
      tasks_omitted: Math.max(0, safe.tasks.length - TEXT_FALLBACK_TASK_PREVIEW),
    };
  }
  if (Array.isArray(safe.tasks)) {
    return {
      kind: 'tasks',
      task_count: safe.tasks.length,
      tasks: safe.tasks.slice(0, TEXT_FALLBACK_TASK_PREVIEW).map(taskPreview).filter(Boolean),
      tasks_omitted: Math.max(0, safe.tasks.length - TEXT_FALLBACK_TASK_PREVIEW),
    };
  }
  if (safe.task && Object.hasOwn(safe, 'view')) {
    return {
      kind: 'task',
      task: taskPreview(safe.task),
      state: typeof safe.state === 'string' ? safe.state : null,
      view: typeof safe.view === 'string' ? safe.view : null,
      wait_reason: typeof safe.progress?.wait_reason === 'string' ? safe.progress.wait_reason : null,
      event_cursor: typeof safe.progress?.event_cursor === 'string' ? safe.progress.event_cursor : null,
      message: clipText(safe.summary?.message ?? safe.diagnostic?.message, 320),
    };
  }
  if (safe.task && Object.hasOwn(safe, 'deadline') && Object.hasOwn(safe, 'runtime')) {
    return {
      kind: 'delegate',
      task: taskPreview(safe.task),
      state: typeof safe.state === 'string' ? safe.state : null,
    };
  }
  if (safe.task) {
    return {
      kind: 'cancel',
      task: taskPreview(safe.task),
    };
  }
  if (safe.mode === 'run' || (safe.experience && typeof safe.experience === 'object')) {
    return summarizeExperienceContent(safe);
  }
  return {
    kind: 'opaque',
    keys: Object.keys(safe).slice(0, 16),
  };
}

function lastResortText(maxBytes) {
  // Keep this ASCII-only and self-describing so tiny caps still report the
  // effective text_max_bytes while remaining valid JSON/UTF-8.
  return JSON.stringify({
    schema: TEXT_FALLBACK_SCHEMA,
    authoritative: 'structuredContent',
    receipt_in_text: false,
    truncated: true,
    text_max_bytes: maxBytes,
    note: LAST_RESORT_NOTE,
  });
}

/**
 * Resolve and clamp an optional maxBytes option.
 * Unsupported values fall back to the default; supported values are floored
 * integers clamped to [LAST_RESORT_MIN_BYTES, TEXT_FALLBACK_MAX_BYTES].
 */
export function resolveTextFallbackMaxBytes(maxBytes = TEXT_FALLBACK_MAX_BYTES) {
  if (maxBytes === undefined || maxBytes === null) return TEXT_FALLBACK_MAX_BYTES;
  const n = Number(maxBytes);
  if (!Number.isFinite(n)) return TEXT_FALLBACK_MAX_BYTES;
  return Math.min(TEXT_FALLBACK_MAX_BYTES, Math.max(LAST_RESORT_MIN_BYTES, Math.floor(n)));
}

function fallbackDocument(safe, summary, {
  structuredBytes,
  truncated,
  truncatedFields = [],
  maxBytes,
} = {}) {
  return {
    schema: TEXT_FALLBACK_SCHEMA,
    authoritative: 'structuredContent',
    receipt_in_text: false,
    truncated: truncated === true,
    structured_bytes: structuredBytes,
    text_max_bytes: maxBytes,
    ...(truncatedFields.length > 0 ? { truncated_fields: truncatedFields } : {}),
    summary,
  };
}

function shrinkSummary(summary, pass) {
  if (!summary || typeof summary !== 'object') return { kind: 'opaque' };
  if (pass === 1) {
    const next = { ...summary };
    if (Array.isArray(next.tasks)) {
      next.tasks = next.tasks.slice(0, 2);
      next.tasks_omitted = Math.max(
        Number(next.tasks_omitted) || 0,
        (Number(next.task_count) || 0) - next.tasks.length,
      );
    }
    if (typeof next.message === 'string') next.message = clipText(next.message, 120);
    if (next.error?.message) {
      next.error = { ...next.error, message: clipText(next.error.message, 120) };
    }
    return next;
  }
  if (pass === 2) {
    const next = { kind: summary.kind ?? 'opaque' };
    if (summary.task) next.task = taskPreview(summary.task);
    if (typeof summary.state === 'string') next.state = summary.state;
    if (typeof summary.healthy === 'boolean') next.healthy = summary.healthy;
    if (Number.isFinite(summary.active)) next.active = summary.active;
    if (Number.isFinite(summary.task_count)) next.task_count = summary.task_count;
    if (summary.error?.code) next.error = { code: summary.error.code, message: clipText(summary.error.message, 80) };
    if (typeof summary.wait_reason === 'string') next.wait_reason = summary.wait_reason;
    if (typeof summary.card === 'string') next.card = summary.card;
    if (typeof summary.phrase === 'string') next.phrase = clipText(summary.phrase, 80);
    if (typeof summary.run_id === 'string') next.run_id = summary.run_id;
    return next;
  }
  return {
    kind: typeof summary.kind === 'string' ? summary.kind : 'opaque',
    note: 'Text fallback truncated; read structuredContent.',
  };
}

/**
 * Build the bounded text fallback. Never returns an empty string.
 * structuredContent is authoritative; text never duplicates the full receipt.
 * Optional maxBytes is validated/clamped; text_max_bytes always reports the
 * effective cap actually enforced for this serialization.
 */
export function buildTextFallback(safe, { maxBytes = TEXT_FALLBACK_MAX_BYTES } = {}) {
  const effectiveMaxBytes = resolveTextFallbackMaxBytes(maxBytes);
  const structuredBytes = byteLength(JSON.stringify(safe ?? {}));
  let summary = summarizeStructuredContent(safe);
  let truncated = false;
  const truncatedFields = [];
  let text = JSON.stringify(fallbackDocument(safe, summary, {
    structuredBytes,
    truncated,
    maxBytes: effectiveMaxBytes,
  }));

  for (let pass = 1; pass <= 3 && byteLength(text) > effectiveMaxBytes; pass += 1) {
    truncated = true;
    truncatedFields.push(`summary_pass_${pass}`);
    summary = shrinkSummary(summary, pass);
    text = JSON.stringify(fallbackDocument(safe, summary, {
      structuredBytes,
      truncated,
      truncatedFields: [...truncatedFields],
      maxBytes: effectiveMaxBytes,
    }));
  }

  if (byteLength(text) > effectiveMaxBytes) {
    text = JSON.stringify({
      schema: TEXT_FALLBACK_SCHEMA,
      authoritative: 'structuredContent',
      receipt_in_text: false,
      truncated: true,
      structured_bytes: structuredBytes,
      text_max_bytes: effectiveMaxBytes,
      truncated_fields: [...truncatedFields, 'hard_cap'],
      summary: { kind: 'opaque', note: 'Text fallback truncated; read structuredContent.' },
    });
  }

  if (byteLength(text) > effectiveMaxBytes) {
    text = lastResortText(effectiveMaxBytes);
  }

  return text;
}

/**
 * Canonical sanitize + undefined→null pass used by both legacy and structured
 * MCP envelopes. Exported so tests can deep-equal against the fixture sanitizer
 * rather than comparing buildToolResult to itself.
 */
export function sanitizeToolPayload(value) {
  const sanitized = sanitizePublicReceipt(value) ?? {};
  return JSON.parse(JSON.stringify(sanitized, (_key, nested) => (
    nested === undefined ? null : nested
  )));
}

export function normalizeResponseMode(responseMode) {
  return responseMode === RESPONSE_MODE_STRUCTURED ? RESPONSE_MODE_STRUCTURED : null;
}

/**
 * Sanitize and wrap a public tool payload as an MCP tool result.
 * Compatibility policy:
 * - structuredContent is always the complete authoritative sanitized receipt.
 * - Default / omitted response_mode: content[0].text is the full JSON-serialized
 *   sanitized receipt (3.1.1 text-only / MCP backwards compatibility).
 * - response_mode "structured": content[0].text is a bounded fallback summary;
 *   structuredContent remains authoritative.
 * - Business payload keys and values in structuredContent are unchanged.
 */
export function buildToolResult(value, { responseMode, uiMeta } = {}) {
  const safe = sanitizeToolPayload(value);
  const mode = normalizeResponseMode(responseMode);
  const result = mode === RESPONSE_MODE_STRUCTURED
    ? {
      content: [{ type: 'text', text: buildTextFallback(safe) }],
      structuredContent: safe,
    }
    : {
      content: [{ type: 'text', text: JSON.stringify(safe) }],
      structuredContent: safe,
    };
  const meta = normalizeToolResultUiMeta(uiMeta);
  if (meta) result._meta = meta;
  return result;
}

function ownerOnlyKey(key) {
  return typeof key === 'string' && OWNER_ONLY_KEYS.includes(key);
}

function utf8Head(value, maxBytes) {
  if (typeof value !== 'string') return null;
  if (!Number.isInteger(maxBytes) || maxBytes < 0) return null;
  const redacted = redactDiagnosticText(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.length <= maxBytes) return redacted;
  const ellipsis = Buffer.from('…', 'utf8');
  if (maxBytes < ellipsis.length) return buffer.subarray(0, maxBytes).toString('utf8');
  let end = maxBytes - ellipsis.length;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}…`;
}

function ownString(object, key) {
  if (object == null || typeof object !== 'object' || Array.isArray(object)) return null;
  if (!Object.hasOwn(object, key)) return null;
  return typeof object[key] === 'string' ? object[key] : null;
}

function ownExactTrue(object, key) {
  return object != null
    && typeof object === 'object'
    && !Array.isArray(object)
    && Object.hasOwn(object, key)
    && object[key] === true;
}

function ownExactFalse(object, key) {
  return object != null
    && typeof object === 'object'
    && !Array.isArray(object)
    && Object.hasOwn(object, key)
    && object[key] === false;
}

const ATTENTION_QUESTION_OWNER_LEAK = /(?:^|[\s,;])(?:argv|env|repository_path|worktree_path|agent_argv|cli_argv)\s*[:=]\s*(?:\[[^\]]*\]|"[^"]*"|'[^']*'|\S+)/giu;
const ATTENTION_QUESTION_PATH_LEAK = /\/(?:tmp|home|Users|var|opt|root|etc|usr)\/[^\s"'`]+/gu;

function sanitizeAttentionQuestion(item) {
  const source = ownString(item, 'question') ?? ownString(item, 'prompt');
  if (source == null) return null;
  const scrubbed = source
    .replace(ATTENTION_QUESTION_OWNER_LEAK, ' [REDACTED]')
    .replace(ATTENTION_QUESTION_PATH_LEAK, '[REDACTED]');
  const clipped = utf8Head(scrubbed, EXPERIENCE_QUESTION_BYTES);
  if (clipped == null || clipped.trim() === '') return null;
  return clipped;
}

function proofBoundAttentionQuestions(receipt) {
  return attentionItems(receipt).map((item) => ({
    assignment_id: typeof item.assignment_id === 'string' ? item.assignment_id : null,
    question_id: typeof item.question_id === 'string' ? item.question_id : null,
    question: sanitizeAttentionQuestion(item),
  }));
}

function bindProofBoundQuestions(items, bound) {
  return items.map((item) => {
    const assignmentId = typeof item.assignment_id === 'string' ? item.assignment_id : null;
    const questionId = typeof item.question_id === 'string' ? item.question_id : null;
    const match = bound.find((entry) => (
      entry.assignment_id === assignmentId && entry.question_id === questionId
    ));
    if (!match) return item;
    return { ...item, question: match.question };
  });
}

function sha40(value) {
  return typeof value === 'string' && SHA40.test(value) ? value.toLowerCase() : null;
}

function digestValue(value) {
  return typeof value === 'string' && DIGEST.test(value) ? value : null;
}

function eventCursorValue(value) {
  return typeof value === 'string' && EVENT_CURSOR.test(value) ? value : null;
}

function stripOwnerOnly(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    return value.slice(0, EXPERIENCE_MAX_LANES).map((entry) => stripOwnerOnly(entry, depth + 1));
  }
  const copy = {};
  for (const key of Object.keys(value)) {
    if (ownerOnlyKey(key)) continue;
    copy[key] = stripOwnerOnly(value[key], depth + 1);
  }
  return copy;
}

function asLanes(receipt) {
  const lanes = Array.isArray(receipt?.lanes) ? receipt.lanes : [];
  return lanes.slice(0, EXPERIENCE_MAX_LANES).filter((lane) => lane && typeof lane === 'object');
}

function laneId(lane) {
  return typeof lane?.assignment_id === 'string' ? lane.assignment_id : null;
}

function laneStatus(lane) {
  return typeof lane?.status === 'string'
    ? lane.status
    : (typeof lane?.phase === 'string' ? lane.phase : null);
}

function laneProvider(lane) {
  return Object.hasOwn(PROVIDER_DISPLAY, lane?.provider) ? lane.provider : null;
}

function providerPhrase(provider) {
  return PROVIDER_DISPLAY[provider] ?? null;
}

function uniqueProviderPhrases(lanes) {
  const seen = new Set();
  for (const lane of lanes) {
    const phrase = providerPhrase(laneProvider(lane));
    if (phrase) seen.add(phrase);
  }
  return PROVIDER_PHRASE_ORDER.filter((phrase) => seen.has(phrase));
}

export function runningPhrase(assignmentCount) {
  if (assignmentCount === 1) return EXPERIENCE_PHRASES.running_one;
  if (Number.isInteger(assignmentCount) && assignmentCount >= 2 && assignmentCount <= EXPERIENCE_MAX_LANES) {
    return `Co-Engineer is running ${assignmentCount} independent assignments`;
  }
  return null;
}

export function preparingPhrase(assignmentCount) {
  if (assignmentCount === 1) return EXPERIENCE_PHRASES.preparing_one;
  if (Number.isInteger(assignmentCount) && assignmentCount >= 2 && assignmentCount <= EXPERIENCE_MAX_LANES) {
    return `Co-Engineer is preparing ${assignmentCount} assignments`;
  }
  return null;
}

function simpleRunHasAuthoritativeRequiredDispatch(receipt, lanes) {
  if (receipt?.schema !== 'codex-co-engineer.run-admission.v1') return true;
  if (receipt?.authoritative_required_dispatch !== true) return false;
  const required = lanes.filter((lane) => lane.required !== false);
  return required.length > 0 && required.every((lane) => (
    lane.prompt_dispatched === true && lane.dispatch_confidence === 'authoritative'
  ));
}

function attentionItems(receipt) {
  const direct = receipt?.attention;
  const fromRecord = Array.isArray(direct?.items) ? direct.items : [];
  const fromNested = Array.isArray(direct?.record?.items) ? direct.record.items : [];
  const source = fromRecord.length > 0 ? fromRecord : fromNested;
  return source.slice(0, EXPERIENCE_MAX_QUESTIONS).filter((item) => item && typeof item === 'object');
}

function replyUnsupported(item, lane) {
  if (item?.reply_capability === 'unsupported') return true;
  const provider = item?.provider ?? lane?.provider;
  return UNSUPPORTED_REPLY_PROVIDERS.includes(provider);
}

function isOpenAttention(receipt, lanes, items) {
  const status = receipt?.attention?.status;
  if (ATTENTION_OPEN_STATUSES.includes(status)) return true;
  if (receipt?.decision_or_attention?.attention === true) return true;
  if (lanes.some((lane) => laneStatus(lane) === 'needs_attention')) return true;
  return items.some((item) => item.disposition === 'pending' || item.disposition == null);
}

function isTerminalLane(lane) {
  if (typeof lane?.task_final === 'boolean') return lane.task_final;
  return TERMINAL_LANE_STATUSES.includes(laneStatus(lane));
}

function laneNeedsReconciliation(lane) {
  if (lane?.task_final === true) return false;
  const status = laneStatus(lane);
  if (RECONCILIATION_LANE_STATUSES.includes(status)) return true;
  return status === 'unresolved' && lane?.prompt_dispatched === true;
}

function laneBlocksTerminal(lane) {
  if (lane?.task_final === false) return true;
  if (lane?.task_final === true) return false;
  const status = laneStatus(lane);
  if (laneNeedsReconciliation(lane)) return true;
  if (ACTIVE_LANE_STATUSES.includes(status)) return true;
  return lane?.prompt_dispatched === true && !isTerminalLane(lane);
}

function receiptNeedsReconciliation(receipt, lanes) {
  const phase = typeof receipt?.phase === 'string'
    ? receipt.phase
    : (typeof receipt?.status === 'string' ? receipt.status : null);
  return RECONCILIATION_PHASES.includes(phase) || lanes.some(laneNeedsReconciliation);
}

function isFinalRun(receipt, lanes) {
  if (lanes.some(laneBlocksTerminal)) return false;
  if (receipt?.journal?.terminal === true) return true;
  if (lanes.length === 0) return false;
  if (lanes.every(isTerminalLane)) return true;
  if (receipt?.complete_candidate_blocked === true && !lanes.some(laneBlocksTerminal)) {
    return true;
  }
  return false;
}

function explicitRunLifecycleCard(receipt, lanes, items) {
  const phase = typeof receipt?.phase === 'string'
    ? receipt.phase
    : (typeof receipt?.status === 'string' ? receipt.status : null);
  if (!RUN_LIFECYCLE_PHASES.includes(phase)) return null;
  if (phase === 'awaiting_consent' || phase === 'needs_attention') return 'attention';
  if (phase === 'completed' || phase === 'failed' || phase === 'cancelled') {
    return lanes.some(laneBlocksTerminal) ? 'run' : 'final';
  }
  if (phase === 'degraded' || phase === 'unresolved') {
    if (isOpenAttention(receipt, lanes, items)) return 'attention';
    if (lanes.length === 0 || lanes.some(laneBlocksTerminal)) return 'run';
    return 'final';
  }
  if (RECONCILIATION_PHASES.includes(phase) || RUN_NONTERMINAL_PHASES.includes(phase)) return 'run';
  return null;
}

function consentObject(receipt) {
  const consent = receipt?.consent;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) return null;
  const request = consent.request && typeof consent.request === 'object' && !Array.isArray(consent.request)
    ? consent.request
    : null;
  return { consent, request };
}

function consentNeedsDecision(receipt) {
  const entry = consentObject(receipt);
  const status = typeof entry?.consent?.status === 'string' ? entry.consent.status : null;
  if (receipt?.phase === 'awaiting_consent') return true;
  return (status === 'pending' || status === 'required') && entry?.request !== null;
}

export function classifyExperienceCard(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return 'run';
  const lanes = asLanes(receipt);
  const items = attentionItems(receipt);
  const explicit = explicitRunLifecycleCard(receipt, lanes, items);
  if (explicit) return explicit;
  if (consentNeedsDecision(receipt)) return 'attention';
  if (isOpenAttention(receipt, lanes, items) && receipt?.attention?.status !== 'resolved'
    && receipt?.attention?.status !== 'reply_committed') {
    return 'attention';
  }
  if (isFinalRun(receipt, lanes)) return 'final';
  return 'run';
}

function projectLaneCard(lane) {
  const assignmentId = laneId(lane);
  const provider = laneProvider(lane);
  const scope = Array.isArray(lane.write_scope)
    ? lane.write_scope.slice(0, 8).map((pattern) => utf8Head(pattern, EXPERIENCE_SCOPE_PATTERN_BYTES)).filter(Boolean)
    : [];
  return {
    assignment_id: assignmentId,
    provider,
    provider_phrase: providerPhrase(provider),
    role: typeof lane.role === 'string' ? lane.role : null,
    required: lane.required !== false,
    scope,
    state: laneStatus(lane),
  };
}

function projectRepository(receipt) {
  const git = receipt.git && typeof receipt.git === 'object' ? receipt.git : {};
  return {
    digest: digestValue(git.digest ?? receipt.repository_digest ?? null),
    base_sha: sha40(git.base_sha ?? receipt.base_sha ?? null),
  };
}

function projectQuestions(items, lanes) {
  const byId = new Map(lanes.map((lane) => [laneId(lane), lane]));
  const questions = [];
  for (const item of items) {
    const assignmentId = typeof item.assignment_id === 'string' ? item.assignment_id : null;
    const lane = byId.get(assignmentId);
    const unsupported = replyUnsupported(item, lane);
    questions.push({
      assignment_id: assignmentId,
      question_id: typeof item.question_id === 'string' ? item.question_id : null,
      session_id: typeof item.session_id === 'string' ? item.session_id : null,
      task_id: typeof item.task_id === 'string' ? item.task_id : null,
      question: utf8Head(item.question ?? item.prompt, EXPERIENCE_QUESTION_BYTES),
      options: unsupported
        ? null
        : (Array.isArray(item.options)
          ? item.options.slice(0, 8).map((option) => utf8Head(String(option), 128)).filter(Boolean)
          : []),
      event_cursor: eventCursorValue(item.event_cursor),
      reply_capability: unsupported ? 'unsupported' : 'same_session',
      disposition: unsupported ? 'unresolved' : (item.disposition === 'answered' ? 'answered' : 'pending'),
    });
  }
  questions.sort((left, right) => String(left.assignment_id).localeCompare(String(right.assignment_id)));
  return questions;
}

const CONSENT_STATUSES = Object.freeze([
  'pending', 'required', 'approved', 'blocked', 'declined', 'cancelled', 'timed_out',
]);

function publicProviderNames(providers) {
  if (!Array.isArray(providers)) return [];
  return providers
    .filter((provider) => Object.hasOwn(PROVIDER_DISPLAY, provider))
    .map((provider) => providerPhrase(provider))
    .filter(Boolean);
}

function consentProviders(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.filter((provider) => Object.hasOwn(PROVIDER_DISPLAY, provider));
}

function projectConsent(receipt) {
  const entry = consentObject(receipt);
  if (!entry && receipt?.phase !== 'awaiting_consent') return null;
  const request = entry?.request ?? {};
  const rawStatus = typeof entry?.consent?.status === 'string' ? entry.consent.status : null;
  const status = CONSENT_STATUSES.includes(rawStatus)
    ? rawStatus
    : (receipt?.phase === 'awaiting_consent' ? 'required' : null);
  const providers = consentProviders(request.providers);
  const repositoryIdentity = digestValue(request.repository_identity);
  const requestKind = request.kind === 'repository_exposure_consent'
    ? request.kind
    : null;
  const pending = consentNeedsDecision(receipt);
  if (!pending && status !== 'blocked' && status !== 'declined' && status !== 'cancelled') return null;
  return {
    kind: requestKind,
    status,
    decision_authority: 'host',
    message: pending
      ? 'This run needs your approval to share the full repository with the selected co-engineers for this run.'
      : 'The host did not approve repository exposure for this run.',
    request: {
      kind: requestKind,
      run_id: typeof request.run_id === 'string' ? request.run_id : null,
      repository_identity: repositoryIdentity,
      providers,
      provider_phrases: publicProviderNames(providers),
      scope: request.scope === 'full_repository' ? request.scope : null,
      duration: request.duration === 'this_run_only' ? request.duration : null,
      remote_mutation: request.remote_mutation === false ? false : null,
    },
  };
}

function projectEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { present: false, digest: null, fact_count: 0, claim_count: 0, kinds: [] };
  }
  const kinds = [];
  const collect = (entry) => {
    const kind = entry?.fact_kind ?? entry?.claim_kind ?? entry?.kind;
    if (typeof kind === 'string' && KNOWN_EVIDENCE_KINDS.includes(kind) && !kinds.includes(kind)) {
      kinds.push(kind);
    }
  };
  if (Array.isArray(raw.facts)) raw.facts.slice(0, 16).forEach(collect);
  if (Array.isArray(raw.claims)) raw.claims.slice(0, 16).forEach(collect);
  if (typeof raw.kind === 'string') collect(raw);
  kinds.sort();
  const factCount = Array.isArray(raw.facts) ? Math.min(raw.facts.length, 64) : 0;
  const claimCount = Array.isArray(raw.claims) ? Math.min(raw.claims.length, 32) : 0;
  return {
    present: factCount > 0 || claimCount > 0 || digestValue(raw.digest) != null,
    digest: digestValue(raw.digest),
    fact_count: factCount,
    claim_count: claimCount,
    kinds,
  };
}

function gitFacts(receipt, lanes) {
  const candidate = receipt.candidate && typeof receipt.candidate === 'object' ? receipt.candidate : {};
  let branch = null;
  let head = sha40(candidate.head ?? candidate.head_sha ?? candidate.sha);
  let tree = sha40(candidate.tree ?? candidate.tree_sha);
  for (const lane of lanes) {
    const task = lane.task && typeof lane.task === 'object' ? lane.task : {};
    if (!branch && typeof task.branch === 'string') branch = task.branch;
    if (!head) head = sha40(task.start_sha ?? lane.starting_ref);
    if (!tree) tree = sha40(task.tree_sha ?? task.tree);
  }
  return {
    branch,
    head,
    tree,
    base_sha: sha40(receipt.git?.base_sha ?? receipt.base_sha),
  };
}

function candidateRecord(receipt) {
  const candidate = receipt?.candidate;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate;
}

function contradictoryCandidate(candidate) {
  const composed = ownExactTrue(candidate, 'composed');
  const ready = ownExactTrue(candidate, 'ready_for_codex_review');
  const acceptedOrReviewed = ownExactTrue(candidate, 'accepted')
    || ownExactTrue(candidate, 'reviewed');
  if (ownExactTrue(candidate, 'rejected')) return true;
  if (ownExactFalse(candidate, 'composed') && (ready || acceptedOrReviewed)) return true;
  if (ownExactFalse(candidate, 'ready_for_codex_review') && acceptedOrReviewed) return true;
  if (ready && !composed) return true;
  if (acceptedOrReviewed && (!composed || !ready)) return true;
  return false;
}

function verifiedFinalAllowed(receipt, lanes) {
  if (receipt?.complete_candidate_blocked === true) return false;
  if (!Array.isArray(lanes) || lanes.length === 0) return false;
  const required = lanes.filter((lane) => lane.required !== false);
  if (required.length === 0) return false;
  if (!required.every((lane) => ACCEPTED_LANE_STATUSES.includes(laneStatus(lane)))) return false;
  if (lanes.some((lane) => UNRESOLVED_LANE_STATUSES.includes(laneStatus(lane)))) return false;
  const candidate = candidateRecord(receipt);
  if (candidate == null) return false;
  if (contradictoryCandidate(candidate)) return false;
  if (candidate.authority !== 'p35') return false;
  if (!ownExactTrue(candidate, 'composed')) return false;
  if (!ownExactTrue(candidate, 'ready_for_codex_review')) return false;
  return ownExactTrue(candidate, 'accepted') || ownExactTrue(candidate, 'reviewed');
}

function experienceSummaryPhrases(card, receipt, lanes) {
  const count = Number.isInteger(receipt?.assignment_count)
    ? receipt.assignment_count
    : lanes.length;
  const phrases = [];
  if (card === 'run') {
    phrases.push(EXPERIENCE_PHRASES.delegating);
    phrases.push(...uniqueProviderPhrases(lanes));
    if (receiptNeedsReconciliation(receipt, lanes)) {
      phrases.push(EXPERIENCE_PHRASES.reconciling);
    } else {
      const running = simpleRunHasAuthoritativeRequiredDispatch(receipt, lanes)
        ? runningPhrase(count)
        : preparingPhrase(count);
      if (running) phrases.push(running);
    }
  } else if (card === 'attention') {
    phrases.push(EXPERIENCE_PHRASES.attention);
  } else if (card === 'final' && verifiedFinalAllowed(receipt, lanes)) {
    phrases.push(EXPERIENCE_PHRASES.verified_final);
  }
  return phrases;
}

function projectRunCard(receipt, lanes) {
  const projectedLanes = lanes.map(projectLaneCard)
    .sort((left, right) => String(left.assignment_id).localeCompare(String(right.assignment_id)));
  return {
    objective: utf8Head(receipt.objective, EXPERIENCE_OBJECTIVE_BYTES),
    repository: projectRepository(receipt),
    lanes: projectedLanes,
    authority: { ...EXPERIENCE_AUTHORITY },
  };
}

function projectAttentionCard(receipt, lanes, items) {
  const awaitingConsent = receipt?.phase === 'awaiting_consent';
  const consent = projectConsent(receipt);
  const consentOnly = awaitingConsent || (consent != null && consentNeedsDecision(receipt));
  const questions = consentOnly ? [] : projectQuestions(items, lanes);
  const affected = [];
  const unsupportedLanes = [];
  if (consentOnly) {
    for (const lane of lanes) {
      const id = laneId(lane);
      if (id) affected.push(id);
    }
  }
  for (const question of questions) {
    if (question.assignment_id && !affected.includes(question.assignment_id)) {
      affected.push(question.assignment_id);
    }
    if (question.reply_capability === 'unsupported' && question.assignment_id) {
      unsupportedLanes.push(question.assignment_id);
    }
  }
  for (const lane of lanes) {
    const id = laneId(lane);
    if (laneStatus(lane) === 'needs_attention' && id && !affected.includes(id)) {
      affected.push(id);
    }
    if (laneStatus(lane) === 'unresolved'
      && (lane.unresolved?.code === UNSUPPORTED_REPLY_CODE || replyUnsupported(null, lane))) {
      if (id && !unsupportedLanes.includes(id)) unsupportedLanes.push(id);
      if (id && !affected.includes(id)) affected.push(id);
    }
  }
  affected.sort();
  unsupportedLanes.sort();
  const unaffected = lanes
    .map(laneId)
    .filter((id) => id && !affected.includes(id))
    .sort();
  const cursor = questions
    .filter((question) => question.reply_capability === 'same_session')
    .map((question) => question.event_cursor)
    .find((value) => value != null)
    ?? questions.map((question) => question.event_cursor).find((value) => value != null)
    ?? eventCursorValue(receipt.attention?.event_cursor)
    ?? null;
  const batchId = typeof receipt.attention?.batch_id === 'string' ? receipt.attention.batch_id : null;
  const revision = Number.isInteger(receipt.attention?.revision) ? receipt.attention.revision : null;
  return {
    ...(consent ? { consent } : {}),
    questions,
    affected_lanes: affected,
    unaffected_lanes: unaffected,
    reply: consentOnly
      ? null
      : {
        structured: true,
        rounds: 1,
        cursor_resume: true,
        event_cursor: cursor,
        run_reply: {
          batch_id: batchId,
          expected_revision: revision,
          reply: {
            round: 1,
            batch_id: batchId,
            answers: questions
              .filter((question) => question.reply_capability === 'same_session')
              .map((question) => ({
                assignment_id: question.assignment_id,
                question_id: question.question_id,
                session_id: question.session_id,
                task_id: question.task_id,
                response: null,
              })),
          },
        },
      },
    unsupported: {
      lanes: unsupportedLanes,
      unresolved: unsupportedLanes.length > 0,
      code: unsupportedLanes.length > 0 ? UNSUPPORTED_REPLY_CODE : null,
    },
  };
}

function bucketLanes(lanes, statuses) {
  return lanes
    .filter((lane) => statuses.includes(laneStatus(lane)))
    .map((lane) => laneId(lane))
    .filter(Boolean);
}

function laneHasObservedOutcome(lane) {
  const status = laneStatus(lane);
  if (status === 'planned' || status === 'prepared' || status === 'session_ready') return false;
  if (lane.prompt_dispatched === false || status === 'failed_pre_prompt') return false;
  return TERMINAL_LANE_STATUSES.includes(status) || lane.prompt_dispatched === true;
}

function projectFinalCard(receipt, lanes) {
  const accepted = bucketLanes(lanes, ACCEPTED_LANE_STATUSES);
  const failed = bucketLanes(lanes, FAILED_LANE_STATUSES);
  const unresolved = bucketLanes(lanes, UNRESOLVED_LANE_STATUSES);
  const reviewLanes = lanes.filter((lane) => lane.role === 'review');
  const testLanes = lanes.filter((lane) => {
    const scope = Array.isArray(lane.write_scope) ? lane.write_scope.join(' ') : '';
    return lane.role === 'verify' || /test/iu.test(scope);
  });
  const reviews = reviewLanes.filter(laneHasObservedOutcome).map(laneId).filter(Boolean);
  const plannedReviews = reviewLanes
    .filter((lane) => !laneHasObservedOutcome(lane))
    .map(laneId)
    .filter(Boolean);
  const tests = testLanes.filter(laneHasObservedOutcome).map(laneId).filter(Boolean);
  const plannedTests = testLanes
    .filter((lane) => !laneHasObservedOutcome(lane))
    .map(laneId)
    .filter(Boolean);
  const candidate = receipt.candidate && typeof receipt.candidate === 'object'
    ? {
      ref: typeof receipt.candidate.ref === 'string' ? receipt.candidate.ref : null,
      composed: receipt.candidate.composed === true,
      ready_for_codex_review: receipt.candidate.ready_for_codex_review === true,
      authority: 'p35',
      accepted: receipt.candidate.accepted === true,
    }
    : {
      ref: null,
      composed: false,
      ready_for_codex_review: false,
      authority: 'p35',
      accepted: false,
    };
  return {
    accepted_lanes: accepted,
    failed_lanes: failed,
    unresolved_lanes: unresolved,
    git: gitFacts(receipt, lanes),
    scope: lanes.map(projectLaneCard).map((lane) => ({
      assignment_id: lane.assignment_id,
      scope: lane.scope,
      role: lane.role,
    })),
    tests: {
      lanes: tests,
      present: tests.length > 0,
      planned_lanes: plannedTests,
    },
    reviews: {
      lanes: reviews,
      present: reviews.length > 0,
      planned_lanes: plannedReviews,
    },
    candidate,
    evidence: projectEvidence(receipt.evidence),
    controls: { ...EXPERIENCE_DENIED_CONTROLS },
  };
}

function projectCoordination(receipt, verified) {
  const hasRun = typeof receipt?.run_id === 'string' && receipt.run_id !== '';
  const operation = typeof receipt?.operation === 'string' ? receipt.operation : null;
  return {
    aggregate_wait: EXPERIENCE_COORDINATION.aggregate_wait,
    submissions: operation === 'submit' || hasRun ? 1 : 0,
    aggregate_wait_count: operation === 'wait' ? 1 : 0,
    verified_final_decisions: verified === true ? 1 : 0,
    grouped_reply: operation === 'reply' ? 1 : 0,
  };
}

function boundProjection(projection) {
  let text = JSON.stringify(projection);
  if (byteLength(text) <= EXPERIENCE_MAX_BYTES) return projection;
  const next = {
    ...projection,
    truncated: true,
  };
  if (next.run?.objective) {
    next.run = { ...next.run, objective: utf8Head(next.run.objective, 120) };
  }
  if (Array.isArray(next.attention?.questions)) {
    next.attention = {
      ...next.attention,
      questions: next.attention.questions.map((question) => ({
        ...question,
        question: utf8Head(question.question, 80),
        options: Array.isArray(question.options) ? question.options.slice(0, 2) : question.options,
      })),
    };
  }
  text = JSON.stringify(next);
  if (byteLength(text) <= EXPERIENCE_MAX_BYTES) return next;
  return {
    schema: EXPERIENCE_SCHEMA,
    version: EXPERIENCE_VERSION,
    card: projection.card,
    summary: {
      phrases: (projection.summary?.phrases ?? []).slice(0, 2),
    },
    truncated: true,
    coordination: projection.coordination,
    authority: EXPERIENCE_AUTHORITY,
  };
}

export function projectExperience(receipt) {
  const boundAttention = proofBoundAttentionQuestions(receipt);
  const safe = stripOwnerOnly(receipt) ?? {};
  const lanes = asLanes(safe);
  const items = bindProofBoundQuestions(attentionItems(safe), boundAttention);
  const card = classifyExperienceCard(safe);
  const phrases = experienceSummaryPhrases(card, safe, lanes);
  const verifiedFinal = card === 'final' && verifiedFinalAllowed(safe, lanes);
  const projection = {
    schema: EXPERIENCE_SCHEMA,
    version: EXPERIENCE_VERSION,
    card,
    summary: {
      phrases,
      delegating: card === 'run' ? EXPERIENCE_PHRASES.delegating : null,
      running: card === 'run' && !receiptNeedsReconciliation(safe, lanes)
        ? (simpleRunHasAuthoritativeRequiredDispatch(safe, lanes)
          ? runningPhrase(Number.isInteger(safe.assignment_count) ? safe.assignment_count : lanes.length)
          : preparingPhrase(Number.isInteger(safe.assignment_count) ? safe.assignment_count : lanes.length))
        : null,
      preparing: card === 'run' && !receiptNeedsReconciliation(safe, lanes)
        && !simpleRunHasAuthoritativeRequiredDispatch(safe, lanes)
        ? preparingPhrase(Number.isInteger(safe.assignment_count) ? safe.assignment_count : lanes.length)
        : null,
      reconciling: card === 'run' && receiptNeedsReconciliation(safe, lanes)
        ? EXPERIENCE_PHRASES.reconciling
        : null,
      attention: card === 'attention' ? EXPERIENCE_PHRASES.attention : null,
      verified_final: verifiedFinal
        ? EXPERIENCE_PHRASES.verified_final
        : null,
    },
    coordination: projectCoordination(safe, verifiedFinal),
    authority: { ...EXPERIENCE_AUTHORITY },
    run_id: typeof safe.run_id === 'string' ? safe.run_id : null,
    truncated: false,
  };
  if (card === 'run') projection.run = projectRunCard(safe, lanes);
  if (card === 'attention') projection.attention = projectAttentionCard(safe, lanes, items);
  if (card === 'final') projection.final = projectFinalCard(safe, lanes);
  return boundProjection(projection);
}

function summarizeExperienceContent(safe) {
  const experience = safe.experience && typeof safe.experience === 'object'
    ? safe.experience
    : projectExperience(safe);
  const phrases = Array.isArray(experience.summary?.phrases)
    ? experience.summary.phrases.slice(0, 4)
    : [];
  return {
    kind: 'experience',
    card: experience.card ?? classifyExperienceCard(safe),
    run_id: typeof safe.run_id === 'string' ? safe.run_id : null,
    phrase: phrases[0] ?? null,
    phrases,
    assignment_count: Number.isInteger(safe.assignment_count) ? safe.assignment_count : null,
  };
}

export function isMcpAppsResourceUri(uri) {
  return typeof uri === 'string'
    && uri.startsWith(MCP_APPS_URI_SCHEME)
    && uri.length > MCP_APPS_URI_SCHEME.length
    && !uri.includes('\\')
    && !uri.includes(' ');
}

export function clientSupportsMcpApps(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const ui = extensions[MCP_APPS_EXTENSION_ID];
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return false;
  const mimeTypes = ui.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APPS_MIME_TYPE);
}

function isMcpAppsResourceDescriptor(resource) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return false;
  if (!isMcpAppsResourceUri(resource.uri)) return false;
  if (resource.mimeType != null && resource.mimeType !== MCP_APPS_MIME_TYPE) return false;
  return true;
}

export function createExperienceUiResourceRegistry(initial = []) {
  const byUri = new Map();
  function register(resource) {
    if (!isMcpAppsResourceDescriptor(resource)) return false;
    byUri.set(resource.uri, Object.freeze({
      uri: resource.uri,
      mimeType: MCP_APPS_MIME_TYPE,
      name: typeof resource.name === 'string' ? resource.name : resource.uri,
      text: typeof resource.text === 'string' ? resource.text : '',
    }));
    return true;
  }
  function unregister(uri) {
    return byUri.delete(uri);
  }
  function get(uri) {
    return byUri.get(uri) ?? null;
  }
  function exists(uri) {
    return byUri.has(uri);
  }
  function list() {
    return [...byUri.values()];
  }
  function clear() {
    byUri.clear();
  }
  if (Array.isArray(initial)) {
    for (const resource of initial) register(resource);
  }
  return Object.freeze({ register, unregister, get, exists, list, clear });
}

const defaultExperienceUiResources = createExperienceUiResourceRegistry();

export function experienceUiResourceRegistry() {
  return defaultExperienceUiResources;
}

export function resolveExperienceToolMeta(toolName, {
  clientCapabilities = null,
  resources = experienceUiResourceRegistry(),
  resourceUri = EXPERIENCE_UI_RESOURCE_URIS.shell,
} = {}) {
  if (!PUBLIC_MCP_TOOLS.includes(toolName)) return null;
  if (!clientSupportsMcpApps(clientCapabilities)) return null;
  if (!isMcpAppsResourceUri(resourceUri)) return null;
  const resource = typeof resources?.get === 'function' ? resources.get(resourceUri) : null;
  if (!resource || resource.mimeType !== MCP_APPS_MIME_TYPE) return null;
  return { ui: { resourceUri } };
}

export function resolveExperienceResultMeta({
  card = null,
  clientCapabilities = null,
  resources = experienceUiResourceRegistry(),
} = {}) {
  if (!clientSupportsMcpApps(clientCapabilities)) return null;
  const preferred = EXPERIENCE_CARD_STATES.includes(card)
    ? EXPERIENCE_UI_RESOURCE_URIS[card]
    : EXPERIENCE_UI_RESOURCE_URIS.shell;
  const candidates = [preferred, EXPERIENCE_UI_RESOURCE_URIS.shell];
  for (const uri of candidates) {
    const resource = typeof resources?.get === 'function' ? resources.get(uri) : null;
    if (resource && resource.mimeType === MCP_APPS_MIME_TYPE && isMcpAppsResourceUri(uri)) {
      return { ui: { resourceUri: uri } };
    }
  }
  return null;
}

export function advertiseMcpAppsCapability({
  clientCapabilities = null,
  resources = experienceUiResourceRegistry(),
} = {}) {
  if (!clientSupportsMcpApps(clientCapabilities)) return null;
  const listed = typeof resources?.list === 'function' ? resources.list() : [];
  if (!Array.isArray(listed) || listed.length === 0) return null;
  return {
    [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] },
  };
}

export function listExperienceUiResourcesForClient({
  clientCapabilities = null,
  resources = experienceUiResourceRegistry(),
} = {}) {
  if (!clientSupportsMcpApps(clientCapabilities)) return null;
  const listed = typeof resources?.list === 'function' ? resources.list() : [];
  if (!Array.isArray(listed) || listed.length === 0) return null;
  return listed.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    mimeType: MCP_APPS_MIME_TYPE,
  }));
}

export function readExperienceUiResourceForClient(uri, {
  clientCapabilities = null,
  resources = experienceUiResourceRegistry(),
} = {}) {
  if (!clientSupportsMcpApps(clientCapabilities)) return null;
  if (!isMcpAppsResourceUri(uri)) return null;
  const resource = typeof resources?.get === 'function' ? resources.get(uri) : null;
  if (!resource || resource.mimeType !== MCP_APPS_MIME_TYPE) return null;
  return {
    uri: resource.uri,
    mimeType: MCP_APPS_MIME_TYPE,
    text: resource.text,
  };
}

function normalizeToolResultUiMeta(uiMeta) {
  if (!uiMeta || typeof uiMeta !== 'object' || Array.isArray(uiMeta)) return null;
  const nested = uiMeta.ui && typeof uiMeta.ui === 'object' && !Array.isArray(uiMeta.ui)
    ? uiMeta.ui.resourceUri
    : null;
  if (!isMcpAppsResourceUri(nested)) return null;
  return { ui: { resourceUri: nested } };
}
