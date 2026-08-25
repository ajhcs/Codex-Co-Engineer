// Neutral builders and injected stubs for the P33 run artifact bridge.
// Tests own the assertions.

import { createHash } from 'node:crypto';

import { ARTIFACT_REF_SCHEMA_ID } from '../../mcp/v3/artifact-ref.mjs';
import { createRunArtifactBridge } from '../../mcp/v3/run-artifact-bridge.mjs';

export const RUN_ID = 'run-artifact-main';
export const OTHER_RUN_ID = 'run-artifact-other';
export const ASSIGNMENT_A = 'assign-a';
export const ASSIGNMENT_B = 'assign-b';
export const RELATIVE_A = `runs/${RUN_ID}/${ASSIGNMENT_A}/provider-report.txt`;
export const RELATIVE_B = `runs/${RUN_ID}/${ASSIGNMENT_B}/git-diff.txt`;
export const FOREIGN_RELATIVE = `runs/${OTHER_RUN_ID}/${ASSIGNMENT_A}/provider-report.txt`;
export const HOSTILE_SECRET = 'sk-live-ATTACKER-SECRET';
export const HOSTILE_TOKEN = 'github_pat_hostiletokenvalue';
export const HOSTILE_PATH = '/tmp/hostile-repo';
export const HOSTILE_BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xx';
export const PLAIN_TEXT = 'lane completed without secrets';
export const SECRET_TEXT = `token ${HOSTILE_SECRET} and ${HOSTILE_TOKEN}`;
export const REDACTED = '[REDACTED]';
export const CLOCK_START = '2026-08-25T22:00:00Z';

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function makeClock(start = CLOCK_START) {
  let current = start;
  return {
    now() {
      return current;
    },
    set(next) {
      current = next;
    },
  };
}

export function makeRawStore() {
  const records = new Map();
  const keyOf = (runId, assignmentId, relativePath) =>
    `${runId}\u0000${assignmentId}\u0000${relativePath}`;

  return {
    async publish({ artifact_ref, bytes, source_truncated }) {
      const key = keyOf(artifact_ref.run_id, artifact_ref.assignment_id, artifact_ref.relative_path);
      const record = {
        artifact_ref: { ...artifact_ref },
        bytes: Buffer.from(bytes),
      };
      if (source_truncated === true || source_truncated === false) {
        record.source_truncated = source_truncated;
      }
      records.set(key, record);
      return { artifact_ref: { ...artifact_ref } };
    },
    async get({ run_id, assignment_id, relative_path }) {
      const record = records.get(keyOf(run_id, assignment_id, relative_path));
      if (!record) return null;
      const view = {
        artifact_ref: { ...record.artifact_ref },
        bytes: Buffer.from(record.bytes),
      };
      if (record.source_truncated === true || record.source_truncated === false) {
        view.source_truncated = record.source_truncated;
      }
      return view;
    },
    async list({ run_id }) {
      const listed = [];
      for (const record of records.values()) {
        if (record.artifact_ref.run_id !== run_id) continue;
        const view = {
          artifact_ref: { ...record.artifact_ref },
          bytes: Buffer.from(record.bytes),
        };
        if (record.source_truncated === true || record.source_truncated === false) {
          view.source_truncated = record.source_truncated;
        }
        listed.push(view);
      }
      return listed;
    },
    async remove({ run_id, assignment_id, relative_path }) {
      records.delete(keyOf(run_id, assignment_id, relative_path));
    },
    size() {
      return records.size;
    },
    snapshot() {
      return [...records.values()].map((record) => ({
        artifact_ref: { ...record.artifact_ref },
        bytes: Buffer.from(record.bytes),
      }));
    },
  };
}

export function makeSanitizer({
  secrets = [HOSTILE_SECRET, HOSTILE_TOKEN, HOSTILE_BEARER],
  sanitizerVersion = 1,
} = {}) {
  return {
    async sanitize({ artifact_ref, source, source_truncated }) {
      let text = Buffer.from(source).toString('utf8');
      let redactionCount = 0;
      for (const secret of secrets) {
        if (!text.includes(secret)) continue;
        text = text.split(secret).join(REDACTED);
        redactionCount += 1;
      }
      const bytes = Buffer.from(text, 'utf8');
      return {
        sanitized_ref: {
          schema: ARTIFACT_REF_SCHEMA_ID,
          run_id: artifact_ref.run_id,
          assignment_id: artifact_ref.assignment_id,
          artifact_kind: artifact_ref.artifact_kind,
          artifact_class: 'sanitized',
          relative_path: artifact_ref.relative_path,
          byte_length: bytes.byteLength,
          sha256: digestOf(bytes),
          media_type: artifact_ref.media_type,
          content_encoding: 'identity',
        },
        bytes,
        redaction_count: redactionCount,
        sanitizer_version: sanitizerVersion,
        source_truncated: source_truncated === true,
        complete: source_truncated !== true,
      };
    },
  };
}

export function makeEvidenceBundle() {
  const events = [];
  return {
    async append(event) {
      events.push({ ...event });
    },
    async list({ run_id, assignment_id } = {}) {
      return events.filter((event) => {
        if (run_id && event.run_id !== run_id) return false;
        if (assignment_id && event.assignment_id !== assignment_id) return false;
        return true;
      });
    },
    events,
  };
}

export function makeBridge(overrides = {}) {
  const rawStore = overrides.rawStore ?? makeRawStore();
  const sanitizer = overrides.sanitizer ?? makeSanitizer();
  const evidenceBundle = overrides.evidenceBundle ?? makeEvidenceBundle();
  const clock = overrides.clock ?? makeClock();
  const bridge = createRunArtifactBridge({
    rawStore,
    sanitizer,
    evidenceBundle,
    clock,
  });
  return { bridge, rawStore, sanitizer, evidenceBundle, clock };
}

export function captureInput(overrides = {}) {
  return {
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    artifact_kind: 'provider_report',
    relative_path: RELATIVE_A,
    media_type: 'text/plain',
    source: PLAIN_TEXT,
    ...overrides,
  };
}

export function projectInput(overrides = {}) {
  return {
    run_id: RUN_ID,
    assignment_id: ASSIGNMENT_A,
    ...overrides,
  };
}

export function cleanupInput(overrides = {}) {
  const proof = overrides.proof === undefined
    ? { run_id: RUN_ID }
    : overrides.proof;
  const rest = { ...overrides };
  delete rest.proof;
  return {
    run_id: RUN_ID,
    proof,
    ...rest,
  };
}

export function decodeSelected(artifact) {
  return Buffer.from(artifact.selected, artifact.selected_encoding).toString('utf8');
}
