import { sanitizePublicReceipt, redactDiagnosticText } from './diagnostics.mjs';

/** Bounded MCP text fallback for clients that only read content[0].text. */
export const TEXT_FALLBACK_SCHEMA = 'co_engineer.mcp_text_fallback.v1';
export const TEXT_FALLBACK_MAX_BYTES = 2_048;
export const TEXT_FALLBACK_TASK_PREVIEW = 5;
export const RESPONSE_MODE_STRUCTURED = 'structured';

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
export function buildToolResult(value, { responseMode } = {}) {
  const safe = sanitizeToolPayload(value);
  const mode = normalizeResponseMode(responseMode);
  if (mode === RESPONSE_MODE_STRUCTURED) {
    return {
      content: [{ type: 'text', text: buildTextFallback(safe) }],
      structuredContent: safe,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}
