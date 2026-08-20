const DEFAULT_RESULT_LIMIT = 4 * 1024;
const DEFAULT_VALUE_MAX_DEPTH = 6;
const DEFAULT_VALUE_MAX_ITEMS = 64;
const DEFAULT_VALUE_MAX_BYTES = 32 * 1024;
const REDACTION_OVERLAP_CHARS = 4 * 1024;
const SENSITIVE_VALUE_KEY = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|bearer|token|password|secret|cookie|credential|private[_-]?key|prompt)/iu;

function validLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_RESULT_LIMIT;
}

function validBound(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validNonNegativeBound(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function wellFormedText(value) {
  const text = String(value ?? '');
  if (typeof text.toWellFormed === 'function') return text.toWellFormed();
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) {
      output += text.slice(index, index + 2);
      index += 1;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      output += '\uFFFD';
    } else {
      output += text[index];
    }
  }
  return output;
}

function codePointCount(text) {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    count += 1;
    if (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))) index += 1;
  }
  return count;
}

function codePointStartIndex(text, count) {
  let index = text.length;
  let remaining = Math.max(0, count);
  while (index > 0 && remaining > 0) {
    index -= 1;
    if (isLowSurrogate(text.charCodeAt(index)) && index > 0 && isHighSurrogate(text.charCodeAt(index - 1))) {
      index -= 1;
    }
    remaining -= 1;
  }
  return index;
}

function takeLastCodePointsRaw(text, count) {
  const raw = String(text ?? '');
  const start = codePointStartIndex(raw, count);
  return raw.slice(start);
}

function takeFirstCodePointsRaw(text, count) {
  const raw = String(text ?? '');
  let index = 0;
  let remaining = Math.max(0, count);
  while (index < raw.length && remaining > 0) {
    index += 1;
    if (isHighSurrogate(raw.charCodeAt(index - 1)) && isLowSurrogate(raw.charCodeAt(index))) index += 1;
    remaining -= 1;
  }
  return raw.slice(0, index);
}

function takeLastCodePoints(text, count) {
  return wellFormedText(takeLastCodePointsRaw(text, count));
}

/**
 * Count Unicode code points (not UTF-16 code units or UTF-8 bytes). Result
 * metadata uses this same unit so an emoji counts as one character.
 */
export function providerCharCount(value) {
  return codePointCount(String(value ?? ''));
}

/**
 * Keep the end of a provider result. Conclusions, test verdicts, and handoff
 * summaries conventionally arrive after the progress/noise at the start.
 * The ellipsis is deliberately placed at the front so it cannot look like a
 * provider-generated conclusion. Limits count Unicode code points.
 */
export function tailText(value, limit = DEFAULT_RESULT_LIMIT) {
  const text = wellFormedText(value);
  const max = validLimit(limit);
  if (codePointCount(text) <= max) return text;
  if (max === 1) return '…';
  return `…${takeLastCodePoints(text, max - 1)}`;
}

function truncatedTail(value, limit) {
  const text = wellFormedText(value);
  const max = validLimit(limit);
  if (max === 1) return '…';
  return `…${takeLastCodePoints(text, max - 1)}`;
}

function tailSuffix(value, limit) {
  const text = String(value ?? '');
  if (text.length > limit * 2) return takeLastCodePointsRaw(text, limit);
  return codePointCount(text) <= limit ? text : takeLastCodePointsRaw(text, limit);
}

// Avoid concatenating a huge provider delta with the retained suffix. The
// retained overlap is bounded, while the incoming chunk is already owned by
// the caller and is scanned only from its tail when it is large.
function appendTail(existing, incoming, limit, overlap = 0) {
  const text = String(incoming ?? '');
  if (!existing) return tailSuffix(text, limit);
  if (text.length > limit * 2) {
    // Keep the previous suffix and the incoming prefix together long enough
    // for a split credential to be redacted, with a gap before the incoming
    // tail so those non-contiguous windows cannot form a false token.
    return `${tailSuffix(existing, overlap)}${takeFirstCodePointsRaw(text, overlap)}\n${tailSuffix(text, limit)}`;
  }
  return tailSuffix(`${existing}${text}`, limit);
}

function countChunkCodePoints(text, previousHighSurrogate) {
  let count = codePointCount(String(text));
  if (previousHighSurrogate && isLowSurrogate(String(text).charCodeAt(0))) count -= 1;
  return count;
}

function metadata({ truncated, originalChars, originalCharsKnown }) {
  if (!truncated) return {};
  const result = { result_truncated: true };
  if (originalCharsKnown && Number.isSafeInteger(originalChars) && originalChars >= 0) {
    result.result_original_chars = originalChars;
  }
  return result;
}

/**
 * Bound one textual provider result after applying the caller's redaction.
 * `originalChars` is optional for already-bounded transport buffers and, when
 * supplied, must be a Unicode code-point count. When it is omitted, the
 * supplied value's Unicode code-point count is known; callers that only have
 * a suffix of an unknown source should set `sourceTruncated` and omit it.
 */
export function boundedProviderResult(value, {
  limit = DEFAULT_RESULT_LIMIT,
  sanitize = (text) => text,
  originalChars,
  sourceTruncated = false,
} = {}) {
  if (value === null || value === undefined) return { value: null };
  const raw = String(value);
  const suppliedCount = validCount(originalChars);
  const safe = wellFormedText(sanitize(raw) ?? '');
  const truncated = sourceTruncated || codePointCount(safe) > validLimit(limit);
  return {
    value: truncated ? truncatedTail(safe, limit) : safe,
    ...metadata({
      truncated,
      originalChars: suppliedCount ?? codePointCount(raw),
      originalCharsKnown: suppliedCount !== null || !sourceTruncated,
    }),
  };
}

/**
 * Incrementally retain a bounded provider result without holding the full
 * provider response in memory. Raw chunks are kept in a bounded tail plus a
 * bounded redaction overlap, then sanitized together at finish so a token
 * split across ACP/JSONL chunks cannot leak. Limits and metadata counts use
 * Unicode code points. `finish({ sourceTruncated })` can mark an upstream-
 * clipped stream whose result size is no longer known. If an append caller
 * supplies `originalChars`, it is also a Unicode code-point count.
 */
export function createProviderResultAccumulator({
  limit = DEFAULT_RESULT_LIMIT,
  sanitize = (text) => text,
} = {}) {
  const max = validLimit(limit);
  const rawWindowLimit = max + REDACTION_OVERLAP_CHARS;
  let rawSuffix = '';
  let originalChars = 0;
  let originalCharsKnown = true;
  let sourceTruncated = false;
  let previousHighSurrogate = false;
  let hasValue = false;

  return {
    append(value, { originalChars: chunkOriginalChars, sourceTruncated: chunkTruncated = false } = {}) {
      if (value === null || value === undefined) return;
      const raw = String(value);
      hasValue = true;
      sourceTruncated ||= chunkTruncated === true;
      const suppliedCount = validCount(chunkOriginalChars);
      const chunkCount = suppliedCount ?? countChunkCodePoints(raw, previousHighSurrogate);
      originalChars += chunkCount;
      if (suppliedCount === null && chunkTruncated === true) originalCharsKnown = false;
      if (raw.length > 0) previousHighSurrogate = isHighSurrogate(raw.charCodeAt(raw.length - 1));
      rawSuffix = appendTail(rawSuffix, raw, rawWindowLimit, REDACTION_OVERLAP_CHARS);
    },
    finish({ sourceTruncated: finalSourceTruncated = false } = {}) {
      if (!hasValue) return { value: null };
      const safe = wellFormedText(sanitize(wellFormedText(rawSuffix)) ?? '');
      const truncated = sourceTruncated || finalSourceTruncated || originalChars > max || codePointCount(safe) > max;
      return {
        value: truncated ? truncatedTail(safe, max) : safe,
        ...metadata({
          truncated,
          originalChars,
          originalCharsKnown: originalCharsKnown && !finalSourceTruncated,
        }),
      };
    },
  };
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function markTruncated(state, { unknown = false } = {}) {
  state.truncated = true;
  if (unknown) state.originalCharsKnown = false;
}

function addStringCount(state, value) {
  state.originalChars += providerCharCount(value);
}

function shrinkStringToBytes(text, buildValue, maxBytes, state) {
  if (jsonByteLength(buildValue(text)) <= maxBytes) return text;
  const count = providerCharCount(text);
  let low = 0;
  let high = count;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = middle === 0 ? '' : truncatedTail(text, middle);
    if (jsonByteLength(buildValue(candidate)) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  markTruncated(state);
  return best;
}

/**
 * Recursively project provider values while preserving the public value
 * shape. Strings are redacted and tail-bounded; objects/arrays are bounded by
 * depth, item count, and serialized UTF-8 bytes. When a projection drops
 * unknown branches, aggregate original-character metadata is omitted. The
 * aggregate character count is the sum of visited textual leaves, in Unicode
 * code points (never UTF-16 units or bytes).
 */
export function boundedProviderValue(value, {
  limit = DEFAULT_RESULT_LIMIT,
  sanitize = (text) => text,
  maxDepth = DEFAULT_VALUE_MAX_DEPTH,
  maxItems = DEFAULT_VALUE_MAX_ITEMS,
  maxBytes = DEFAULT_VALUE_MAX_BYTES,
} = {}) {
  const textLimit = validLimit(limit);
  const depthLimit = validNonNegativeBound(maxDepth, DEFAULT_VALUE_MAX_DEPTH);
  const itemLimit = validNonNegativeBound(maxItems, DEFAULT_VALUE_MAX_ITEMS);
  const byteLimit = validBound(maxBytes, DEFAULT_VALUE_MAX_BYTES);
  const state = { truncated: false, originalChars: 0, originalCharsKnown: true, seen: new WeakSet() };

  const project = (input, depth) => {
    if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') return input ?? null;
    if (typeof input === 'string') {
      addStringCount(state, input);
      const bounded = boundedProviderResult(input, { limit: textLimit, sanitize });
      if (bounded.result_truncated) state.truncated = true;
      return bounded.value;
    }
    if (typeof input === 'bigint') {
      const text = String(input);
      addStringCount(state, text);
      const bounded = boundedProviderResult(text, { limit: textLimit, sanitize });
      if (bounded.result_truncated) state.truncated = true;
      return bounded.value;
    }
    if (typeof input === 'function' || typeof input === 'symbol') {
      markTruncated(state, { unknown: true });
      return '[redacted]';
    }
    if (depth >= depthLimit) {
      markTruncated(state, { unknown: true });
      return '[truncated]';
    }
    if (input instanceof Date) return input.toISOString();
    if (input instanceof Error) {
      return projectObject({
        name: input.name,
        ...(input.code ? { code: input.code } : {}),
        message: input.message,
      }, depth);
    }
    if (state.seen.has(input)) {
      markTruncated(state, { unknown: true });
      return '[circular]';
    }
    state.seen.add(input);
    try {
      if (Array.isArray(input)) return projectArray(input, depth);
      return projectObject(input, depth);
    } finally {
      state.seen.delete(input);
    }
  };

  function projectObject(input, depth) {
    const entries = [];
    let total = 0;
    for (const key in input) {
      if (!Object.hasOwn(input, key)) continue;
      total += 1;
      if (itemLimit > 0) {
        if (entries.length >= itemLimit) entries.shift();
        entries.push([key, input[key]]);
      }
    }
    if (total > itemLimit) markTruncated(state, { unknown: true });
    const kept = [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index];
      const buildValue = (replacement) => Object.fromEntries([
        ...kept.map((entry) => [entry[0], entry[1]]),
        [key, replacement],
      ].reverse());
      let projected;
      if (SENSITIVE_VALUE_KEY.test(key)) {
        if (typeof child === 'string') addStringCount(state, child);
        else markTruncated(state, { unknown: true });
        projected = '[redacted]';
      } else {
        projected = project(child, depth + 1);
      }
      const fitted = typeof projected === 'string'
        ? shrinkStringToBytes(projected, buildValue, byteLimit, state)
        : projected;
      const candidate = buildValue(fitted);
      if (jsonByteLength(candidate) > byteLimit) {
        markTruncated(state, { unknown: true });
        continue;
      }
      kept.push([key, fitted]);
    }
    const output = {};
    for (const [key, child] of kept.reverse()) output[key] = child;
    return output;
  }

  function projectArray(input, depth) {
    const start = Math.max(0, input.length - itemLimit);
    if (start > 0) markTruncated(state, { unknown: true });
    const kept = [];
    for (let index = input.length - 1; index >= start; index -= 1) {
      const child = input[index];
      const buildValue = (replacement) => [replacement, ...kept];
      const projected = project(child, depth + 1);
      const fitted = typeof projected === 'string'
        ? shrinkStringToBytes(projected, buildValue, byteLimit, state)
        : projected;
      const candidate = buildValue(fitted);
      if (jsonByteLength(candidate) > byteLimit) {
        markTruncated(state, { unknown: true });
        continue;
      }
      kept.push(fitted);
    }
    return kept.reverse();
  }

  let projected = project(value, 0);
  if (typeof projected === 'string') {
    projected = shrinkStringToBytes(projected, (replacement) => replacement, byteLimit, state);
  }
  if (jsonByteLength(projected) > byteLimit) {
    markTruncated(state, { unknown: true });
    // If even the smallest representation of the retained shape cannot fit,
    // use the smallest valid JSON scalar so the advertised byte bound remains
    // hard even for pathological caller limits.
    projected = 0;
  }
  return {
    value: projected,
    ...metadata({
      truncated: state.truncated,
      originalChars: state.originalChars,
      originalCharsKnown: state.originalCharsKnown,
    }),
  };
}

export const MAX_PROVIDER_RESULT_CHARS = DEFAULT_RESULT_LIMIT;
