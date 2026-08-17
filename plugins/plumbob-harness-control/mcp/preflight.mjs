import { createHash } from 'node:crypto';

// These values are deliberately independent from the package version.  A
// caller can therefore pin the wire/configuration contract while the plugin
// receives a patch release.
export const CONFIG_SCHEMA_VERSION = 'codex-co-engineer.config.v1';
export const TARGET_SCHEMA_VERSION = 'codex-co-engineer.target.v1';
export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2024-11-05',
]);

export const SERVER_IDENTITY = Object.freeze({
  name: 'plumbob-harness-control',
  version: '2.0.3',
});

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot digest a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new TypeError(`Cannot digest value of type ${typeof value}.`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Digest(value) {
  const bytes = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-f]{64}$/i.test(normalized) ? normalized.toLowerCase() : null;
}

export function toolSetDigest(tools) {
  return sha256Digest(tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
  })).sort((left, right) => left.name.localeCompare(right.name)));
}

export function targetIdentityDigest(identity) {
  return sha256Digest({
    schema_version: TARGET_SCHEMA_VERSION,
    ...identity,
  });
}
