#!/usr/bin/env node

import readline from 'node:readline';

import {
  MAX_EXPECTED_DURATION_MS,
  MAX_TIMEOUT_MS,
  MCP_PENDING_CALL_BUDGET_MS,
  MIN_DURATION_MS,
  VERSION,
  publicState,
} from './contract.mjs';
import {
  COMPACT_VIEW,
  WAIT_ANY_TASK_STRUCTURED_BYTES_MAX,
  enforceWaitAnyResponseBudget,
  projectCompactTask,
  projectWaitAnyProgress,
} from './compact-task.mjs';
import { deadlineProjection } from './deadline.mjs';
import { compactTaskCard, sanitizePublicReceipt } from './diagnostics.mjs';
import {
  advertiseMcpAppsCapability,
  buildToolResult,
  listExperienceUiResourcesForClient,
  normalizeResponseMode,
  readExperienceUiResourceForClient,
  resolveExperienceResultMeta,
  resolveExperienceToolMeta,
} from './response.mjs';
import {
  MCP_RESOURCE_NOT_FOUND,
  clientAdvertisesCompatibleAppsUi,
  experienceUiResourcesForClient,
} from './experience-ui-resource.mjs';
import { listTasks, listTasksPage, stateRoot, waitForAnyTaskProgress } from './task-store.mjs';
import {
  cancelTask,
  inspectTask,
  invokeRunTool,
  projectSupervisorPublicState,
  projectSupervisorTaskRecords,
  projectSupervisorTerminalReceipt,
  submitTask,
  supervisorStatus,
} from './supervisor.mjs';
import {
  classifyRunToolCall,
} from './run-tool-adapter.mjs';
import { createNativeConsentTransport } from './consent.mjs';

const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
let negotiated = '2025-11-25';
let clientCapabilities = null;
const inflight = new Map();

function uiResources() {
  return experienceUiResourcesForClient(clientCapabilities);
}

function serverCapabilities() {
  const capabilities = { tools: { listChanged: false } };
  const apps = advertiseMcpAppsCapability({
    clientCapabilities,
    resources: uiResources(),
  });
  if (apps) {
    capabilities.extensions = apps;
    capabilities.resources = { listChanged: false };
  }
  return capabilities;
}

function advertisedTools() {
  return TOOLS.map((tool) => {
    const meta = resolveExperienceToolMeta(tool.name, {
      clientCapabilities,
      resources: uiResources(),
    });
    if (!meta) return tool;
    return { ...tool, _meta: meta };
  });
}

const RESPONSE_MODE_PROPERTY = {
  type: 'string',
  enum: ['structured'],
  description: 'Optional presentation control stripped before business logic. Capable clients default to the bounded structured-first transport; legacy clients omit this field for the full sanitized receipt in content[0].text. Set to "structured" explicitly when needed.',
};

const RESPONSE_MODE_HINT = ' Capable clients receive structured-first bounded text by default; legacy clients may set response_mode="structured" explicitly or omit it for the full compatible receipt.';

const TOOLS = [
  {
    name: 'status',
    description: `Show the local Co-Engineer supervisor, provider capabilities, advertised MCP pending-call budget, and recent task state.${RESPONSE_MODE_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['full', 'compact'], description: 'full returns full receipts (default). compact returns redacted compact cards.' },
        task_limit: { type: 'integer', minimum: 0, maximum: 20, description: 'Maximum tasks to return (0-20). Default 20. Ignored when include_tasks is false.' },
        include_tasks: { type: 'boolean', description: 'When false, omit recent tasks for readiness-only checks.' },
        refresh: { type: 'boolean', description: 'Force a fresh provider-readiness probe. Without refresh, readiness is shared for a short local TTL and cold probes are bounded.' },
        response_mode: RESPONSE_MODE_PROPERTY,
        run_id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{2,63}$',
          description: 'Optional exact run id. When present, status inspects the bounded run instead of the 3.2.1 task window. Omit to preserve the 3.2.1 supervisor snapshot.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delegate',
    description: `Delegate a review or implementation task to Grok, Cursor Local, Cursor Cloud, or DSH. The absolute Git worktree path must be supplied in the property named repo. Provide expected_duration_ms or a backwards-compatible timeout_ms; the recorded deadline is ceil(expected_duration_ms * 1.20) unless timeout_ms is an explicit override of at least that margin. Local tasks use a managed worktree by default; direct mode is explicit.${RESPONSE_MODE_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        provider: { type: 'string', enum: ['grok', 'cursor-local', 'cursor-cloud', 'dsh'] },
        dsh_model: {
          type: 'string',
          enum: ['muse-spark-1.2-contributor', 'stealth/ox-alpha'],
          description: 'DSH only. Defaults to Muse Spark 1.2 Contributor; select stealth/ox-alpha for the OpenRouter-backed Ox Alpha route.',
        },
        repo: { type: 'string', description: 'Required property named repo: absolute path to the Git worktree (for example, /absolute/path/to/git-worktree). Do not rename this property to git_root or repository.' },
        prompt: { type: 'string', minLength: 1, maxLength: 262144 },
        role: { type: 'string', enum: ['review', 'implement'], default: 'implement' },
        workspace_mode: { type: 'string', enum: ['managed', 'direct'], default: 'managed' },
        expected_duration_ms: {
          type: 'integer',
          minimum: MIN_DURATION_MS,
          maximum: MAX_EXPECTED_DURATION_MS,
          description: 'Codex estimate of task runtime. Recorded deadline is ceil(expected_duration_ms * 1.20) unless timeout_ms is supplied as an explicit override of at least that margin.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: MIN_DURATION_MS,
          maximum: MAX_TIMEOUT_MS,
          description: 'Backwards-compatible explicit deadline. Required when expected_duration_ms is omitted. When both are supplied, timeout_ms must be at least ceil(expected_duration_ms * 1.20).',
        },
        silence_timeout_ms: {
          type: 'integer',
          minimum: 5000,
          maximum: 86400000,
          description: 'Optional provider-silence watchdog. A terminal wait wakes if no durable activity arrives within this window.',
        },
        create_pr: { type: 'boolean', default: false, description: 'Cursor Cloud only.' },
        starting_ref: { type: 'string', pattern: '^[a-fA-F0-9]{40}$', description: 'Optional immutable commit SHA for Cursor Cloud only; it does not replace the required repo property.' },
        provider_repo_url: { type: 'string', minLength: 1, maxLength: 4096, description: 'Optional credential-free provider-visible repository URL override for Cursor Cloud. SSH origins are canonicalized to HTTPS without credentials.' },
        provider_repo: { type: 'string', minLength: 1, maxLength: 4096, description: 'Backward-compatible alias for provider_repo_url; Cursor Cloud only.' },
        response_mode: RESPONSE_MODE_PROPERTY,
        run_request: {
          type: 'object',
          additionalProperties: false,
          required: ['run_id', 'repo', 'objective', 'assignments'],
          description: '3.4.2 simple run request. The server derives Git identity, provider models, task IDs, workspaces, dispatch identities, and protected telemetry. Do not supply derived provenance fields.',
          properties: {
            run_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
            repo: { type: 'string', description: 'Canonical absolute Git worktree path.' },
            objective: { type: 'string', minLength: 1, maxLength: 4096 },
            base_sha: { type: 'string', pattern: '^[0-9a-f]{40}$', description: 'Optional exact local base SHA; omitted means the observed clean HEAD.' },
            assignments: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['assignment_id', 'provider', 'role', 'prompt', 'expected_duration_ms'],
                properties: {
                  assignment_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
                  provider: { type: 'string', enum: ['grok', 'cursor-local', 'cursor-cloud', 'dsh'] },
                  model: { type: 'string', maxLength: 128, description: 'Optional exact model override; otherwise the closed provider default is derived.' },
                  role: { type: 'string', enum: ['implement', 'review', 'verify'] },
                  access: { type: 'string', enum: ['write', 'writer', 'read', 'read_only'], description: 'Optional explicit access. Omitted access is derived from role: implement means writer; review and verify mean read_only.' },
                  prompt: { type: 'string', minLength: 1, maxLength: 16384 },
                  expected_duration_ms: { type: 'integer', minimum: MIN_DURATION_MS, maximum: MAX_EXPECTED_DURATION_MS },
                  write_scope: { type: 'array', minItems: 0, maxItems: 16, items: { type: 'string' }, description: 'Optional for writers; required explicitly for each writer when more than one writer lane exists. Read-only lanes must use an empty scope.' },
                  required: { type: 'boolean', default: true },
                  capabilities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['read_run_receipts', 'read_provider_logs', 'read_own_worktree'] } },
                },
              },
            },
          },
        },
        run: {
          type: 'object',
          additionalProperties: false,
          required: ['run_id', 'request_idempotency_key', 'identity', 'git', 'provenance', 'telemetry', 'assignments'],
          description: 'Optional bounded-run submission. When present, delegate submits one 1-8 lane run instead of a 3.2.1 single task. Direct mode, replay, fallback, and merge/push/create-PR are rejected. Omit to preserve exact 3.2.1 delegate behavior.',
          properties: {
            run_id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
            request_idempotency_key: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
            identity: { type: 'object' },
            git: { type: 'object' },
            provenance: { type: 'object' },
            telemetry: { type: 'object' },
            objective: { type: 'string', minLength: 1, maxLength: 4096 },
            profile: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
            assignments: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: { type: 'object' },
            },
          },
        },
      },
      allOf: [
        {
          if: { anyOf: [{ required: ['run'] }, { required: ['run_request'] }] },
          then: { oneOf: [{ required: ['run'] }, { required: ['run_request'] }] },
          else: {
            required: ['task_id', 'provider', 'repo', 'prompt'],
            anyOf: [
              { required: ['expected_duration_ms'] },
              { required: ['timeout_ms'] },
            ],
          },
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'task',
    description: `Inspect one task. view=summary is the default receipt plus diagnostic envelope and event_cursor. view=compact is a bounded coordination payload without full task or runtime bodies. view=diagnostics is a side-effect-free cursor-paged evidence page. wait_until=terminal waits for a terminal or needs-attention state without waking on routine text. Optional reply delivers a same-session answer exactly once. Optional extend_* records an audited deadline extension. Disconnecting this waiter does not stop provider work. Unsolicited stdio callbacks across assistant turns are not available.${RESPONSE_MODE_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: MCP_PENDING_CALL_BUDGET_MS,
          description: 'Optional bounded wait. 0 is a non-blocking snapshot. Omit with wait_until=terminal to wait until the recorded deadline, capped by the advertised MCP pending-call budget.',
        },
        wait_until: {
          type: 'string',
          enum: ['progress', 'terminal', 'decision_or_attention'],
          description: 'progress wakes on meaningful live events (default). terminal waits for success, failure, timeout, cancellation, transport loss, environment block, needs_attention, silence, or the recorded deadline, and does not wake on routine text deltas. decision_or_attention is the additive run wait and never wakes on routine progress.',
        },
        wake_on_needs_attention: {
          type: 'boolean',
          default: true,
          description: 'When wait_until=terminal, wake if the provider needs a same-session reply. Default true.',
        },
        view: {
          type: 'string',
          enum: ['summary', 'diagnostics', 'compact'],
          description: 'summary is the default receipt plus diagnostic envelope. compact is a bounded coordination payload without full task or runtime bodies. diagnostics is a bounded, redacted, cursor-paged evidence page and never waits.',
        },
        cursor: {
          type: 'string',
          pattern: '^[0-9]{1,16}$',
          description: 'Opaque event_cursor from a previous task result. Wait or page from this boundary instead of hammering empty polls.',
        },
        max_bytes: {
          type: 'integer',
          minimum: 1024,
          maximum: 65536,
          description: 'Diagnostics page size cap.',
        },
        extend_expected_duration_ms: {
          type: 'integer',
          minimum: MIN_DURATION_MS,
          maximum: MAX_EXPECTED_DURATION_MS,
          description: 'Replace the remaining estimate. The new deadline is now + ceil(extend_expected_duration_ms * 1.20) and must be strictly later than the recorded deadline. Requires extend_reason. Never silently rolls the deadline.',
        },
        extend_reason: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
          description: 'Required when extending the deadline. Persisted on the receipt.',
        },
        reply: {
          type: 'object',
          additionalProperties: false,
          required: ['session_id', 'question_id', 'response'],
          description: 'Exactly-once same-session reply for a needs_attention question. Unsupported providers return an explicit error instead of starting a new prompt.',
          properties: {
            session_id: { type: 'string', minLength: 1, maxLength: 128 },
            question_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
            response: { description: 'Selected option id, permission outcome, or bounded text.' },
          },
        },
        response_mode: RESPONSE_MODE_PROPERTY,
        run_id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{2,63}$',
          description: 'Optional exact run id. When present, task inspects, waits, latches attention, or replies on the bounded run. Omit with task_id to preserve exact 3.2.1 task behavior.',
        },
        assignment_id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{0,63}$',
          description: 'Optional exact assignment id for a run-scoped task inspect.',
        },
        attention: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          description: 'Latch one run-level AttentionBatchV1. Exactly one reply round. Routine progress never wakes.',
          properties: {
            expected_revision: { type: 'integer', minimum: 0 },
            items: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object' } },
          },
        },
        run_reply: {
          type: 'object',
          additionalProperties: false,
          description: 'Exactly-once run attention reply, a host approval reference, or a typed repository-consent continuation. Do not mix alternatives or 3.2.1 task.reply.',
          properties: {
            approval_ref: { type: 'string', minLength: 1, maxLength: 4096, description: 'Opaque host-minted repository-exposure approval reference. It is bound to this run and never emitted in telemetry.' },
            batch_id: { type: 'string', minLength: 1, maxLength: 128 },
            expected_revision: { type: 'integer', minimum: 0 },
            reply: { type: 'object' },
            request_consent: { type: 'boolean', const: true, description: 'Ask the host to reopen the native repository-access form for this run.' },
          },
          oneOf: [
            {
              required: ['batch_id', 'reply'],
              not: { anyOf: [{ required: ['approval_ref'] }, { required: ['request_consent'] }] },
            },
            {
              required: ['approval_ref'],
              not: { anyOf: [{ required: ['batch_id'] }, { required: ['expected_revision'] }, { required: ['reply'] }, { required: ['request_consent'] }] },
            },
            {
              required: ['request_consent'],
              properties: { request_consent: { const: true } },
              not: { anyOf: [{ required: ['approval_ref'] }, { required: ['batch_id'] }, { required: ['expected_revision'] }, { required: ['reply'] }] },
            },
          ],
        },
      },
      allOf: [
        {
          if: { required: ['run_id'] },
          then: { required: ['run_id'] },
          else: { required: ['task_id'] },
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'tasks',
    description: `List recent task receipts with optional compact keyset pagination and filters. With task_ids, wait concurrently for the first of 1-8 exact tasks to reach progress or terminal (including needs_attention), using optional per-task cursors and one bounded wait; a timeout returns compact current snapshots for every target. Wait-any task snapshots and live event previews are individually bounded; call task with a target ID for full event detail. Disconnecting the waiter does not stop providers.${RESPONSE_MODE_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', enum: ['full', 'compact'], description: 'full returns full receipts (default). compact returns redacted compact cards.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Page size (1-20). Default all (or 20 for compact). Values above 20 are invalid.' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from previous tasks response.' },
        provider: { type: 'string', enum: ['grok', 'cursor-local', 'cursor-cloud', 'dsh'], description: 'Filter by provider.' },
        state: { type: 'string', description: 'Filter by public state (e.g. running, succeeded, failed, transport_lost, needs_attention).' },
        status: { type: 'string', description: 'Alias for state filter (stored or public status).' },
        response_mode: RESPONSE_MODE_PROPERTY,
        task_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
          description: 'Exact task IDs to coordinate. Supply 1-8 IDs for wait-any mode.',
        },
        cursors: {
          type: 'object',
          maxProperties: 8,
          propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
          additionalProperties: { type: 'string', pattern: '^[0-9]{1,16}$' },
          description: 'Optional event cursor per task ID. A current cursor suppresses already-delivered progress.',
        },
        wait_ms: {
          type: 'integer',
          minimum: 0,
          maximum: MCP_PENDING_CALL_BUDGET_MS,
          description: `Bounded shared wait from 0 to ${MCP_PENDING_CALL_BUDGET_MS} ms. Omit with wait_until=terminal to follow each recorded deadline up to the advertised MCP pending-call budget.`,
        },
        wait_until: {
          type: 'string',
          enum: ['progress', 'terminal', 'decision_or_attention'],
          description: 'progress wakes on meaningful progress; terminal wakes on terminal, needs_attention, silence, or deadline. decision_or_attention waits for the run-level attention batch without waking on routine text.',
        },
        wake_on_needs_attention: {
          type: 'boolean',
          default: true,
          description: 'Wake when any target needs a same-session reply or loses transport. Default true.',
        },
        run_id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{2,63}$',
          description: 'Optional exact run id. When present, tasks waits on the run\'s 1-8 lanes through decision_or_attention. Omit to preserve 3.2.1 list or wait-any behavior.',
        },
      },
      allOf: [
        {
          if: {
            allOf: [
              {
                anyOf: [
                  { required: ['cursors'] },
                  { required: ['wait_ms'] },
                  { required: ['wait_until'] },
                  { required: ['wake_on_needs_attention'] },
                ],
              },
              { not: { required: ['run_id'] } },
            ],
          },
          then: { required: ['task_ids'] },
        },
        {
          not: {
            allOf: [
              {
                anyOf: [
                  { required: ['task_ids'] },
                  { required: ['cursors'] },
                  { required: ['wait_ms'] },
                  { required: ['wait_until'] },
                  { required: ['wake_on_needs_attention'] },
                ],
              },
              {
                anyOf: [
                  { required: ['detail'] },
                  { required: ['limit'] },
                  { required: ['cursor'] },
                  { required: ['provider'] },
                  { required: ['state'] },
                  { required: ['status'] },
                ],
              },
            ],
          },
        },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'cancel',
    description: `Cancel one owned local process group or Cursor Cloud run.${RESPONSE_MODE_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' },
        response_mode: RESPONSE_MODE_PROPERTY,
        run_id: {
          type: 'string',
          pattern: '^[a-z][a-z0-9-]{2,63}$',
          description: 'Optional exact run id. When present, cancel stops named run lanes. Omit with task_id to preserve exact 3.2.1 cancel behavior.',
        },
        assignment_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
          description: 'Exact assignment ids to cancel in the named run. Required for run cancel when run_id is present.',
        },
        cleanup: {
          type: 'boolean',
          description: 'Proof-bound run artifact cleanup. Requires P33 lifecycle finality. Worktrees, branches, locks, and candidate refs are never deleted here.',
        },
      },
      allOf: [
        {
          if: { required: ['run_id'] },
          then: { required: ['run_id'] },
          else: { required: ['task_id'] },
        },
      ],
      additionalProperties: false,
    },
  },
];

function publicTask(task) {
  if (!task) return task;
  const {
    agent_argv: _agentArgv,
    cli_argv: _cliArgv,
    provider_process_group: _providerProcessGroup,
    provider_process_start_ticks: _providerProcessStartTicks,
    ...receipt
  } = task;
  return sanitizePublicReceipt({
    ...receipt,
    state: publicState(task.status),
    deadline: deadlineProjection(task),
  });
}

function projectWaitAnyEntry(entry) {
  const projectedTask = entry.task ? projectSupervisorTerminalReceipt(entry.task) : null;
  return {
    task_id: entry.task_id,
    // Wait-any can return up to eight receipts at once. Keep the fresh
    // event stream in the separate progress envelope, while each task
    // is a bounded coordination projection instead of a full receipt.
    task: projectedTask ? projectCompactTask({
      task: projectedTask,
      progress: entry.progress,
      maxBytes: WAIT_ANY_TASK_STRUCTURED_BYTES_MAX,
    }) : null,
    progress: projectWaitAnyProgress(entry.progress),
    state: entry.task ? projectSupervisorPublicState(entry.task) : null,
    error: entry.error,
  };
}

function takePresentationArgs(args = {}) {
  const { response_mode: responseModeRaw, ...businessArgs } = args;
  return {
    responseMode: responseModeRaw === undefined && clientSupportsStructuredResponses()
      ? 'structured'
      : normalizeResponseMode(responseModeRaw),
    args: businessArgs,
  };
}

function clientSupportsStructuredResponses() {
  if (!clientCapabilities || typeof clientCapabilities !== 'object' || Array.isArray(clientCapabilities)) return false;
  if (clientCapabilities.structuredContent === true) return true;
  if (clientCapabilities.experimental?.structuredContent === true) return true;
  return clientCapabilities.experimental?.['codex-co-engineer']?.structured_content === true;
}

function result(value, { responseMode } = {}) {
  const uiMeta = value?.mode === 'run'
    ? resolveExperienceResultMeta({
      card: value?.experience?.card ?? null,
      clientCapabilities,
      resources: uiResources(),
    })
    : null;
  return buildToolResult(value, { responseMode, uiMeta });
}

function errorResult(error, { responseMode } = {}) {
  const code = typeof error?.code === 'string' ? error.code : 'co_engineer_error';
  const message = error instanceof Error ? error.message : 'Co-Engineer request failed.';
  return { isError: true, ...result({ error: { code, message } }, { responseMode }) };
}

async function callTool(name, args = {}, { signal, responseMode } = {}) {
  const root = stateRoot();
  const classified = classifyRunToolCall(name, args);
  if (classified.mode === 'run') {
    if (name === 'cancel' && typeof args?.run_id === 'string') {
      nativeConsent.cancelRun(args.run_id);
    }
    const value = await invokeRunTool(root, name, args, {
      signal,
      requestConsent: nativeConsent.requestConsent,
    });
    if (value?.mode === 'legacy') {
      // Fall through only when classification and dispatch disagree; omission stays 3.2.1.
    } else {
      return result(value, { responseMode });
    }
  }
  if (name === 'status') {
    const hasCompact = args && (args.detail !== undefined || args.task_limit !== undefined || args.include_tasks !== undefined || args.refresh !== undefined);
    if (!hasCompact) {
      const value = await supervisorStatus(root);
      return result({ ...value, tasks: value.tasks.map(publicTask) }, { responseMode });
    }
    const value = await supervisorStatus(root, {}, args);
    // Compact/readiness paths must avoid constructing/projecting omitted full public receipts.
    // Only project the window; never build full receipts for compact.
    if (value.detail === 'compact') {
      return result(value, { responseMode });
    }
    return result({ ...value, tasks: value.tasks.map(publicTask) }, { responseMode });
  }
  if (name === 'delegate') {
    const value = await submitTask(args, { root });
    return result({
      task: publicTask(value.task),
      runtime: value.runtime,
      state: publicState(value.task.status),
      deadline: deadlineProjection(value.task),
    }, { responseMode });
  }
  if (name === 'task') {
    const value = await inspectTask(root, args, { signal });
    if (value?.view === COMPACT_VIEW) return result(value, { responseMode });
    return result({
      task: publicTask(value.task),
      runtime: value.runtime,
      progress: value.progress,
      state: value.state,
      summary: value.summary,
      diagnostic: value.diagnostic,
      diagnostics: value.diagnostics ?? null,
      capabilities: value.capabilities,
      view: value.view,
    }, { responseMode });
  }
  if (name === 'tasks') {
    const hasWaitAnyArgs = args && (args.task_ids !== undefined || args.cursors !== undefined || args.wait_ms !== undefined || args.wait_until !== undefined || args.wake_on_needs_attention !== undefined);
    const hasListArgs = args && (args.detail !== undefined || args.limit !== undefined || args.cursor !== undefined || args.provider !== undefined || args.state !== undefined || args.status !== undefined);
    if (hasWaitAnyArgs && hasListArgs) {
      throw Object.assign(new Error('tasks list options cannot be combined with wait-any options.'), { code: 'invalid_tasks_mode' });
    }
    if (hasWaitAnyArgs) {
      const value = await waitForAnyTaskProgress(root, {
        ...args,
        signal,
      });
      const waitAny = {
        tasks: value.tasks.map(projectWaitAnyEntry),
        wait_reason: value.wait_reason,
        wait_until: value.wait_until,
        waited_ms: value.waited_ms,
        triggered_task_id: value.triggered_task_id,
      };
      return result(enforceWaitAnyResponseBudget(waitAny), { responseMode });
    }
    if (!hasListArgs) {
      return result({ tasks: projectSupervisorTaskRecords(await listTasks(root)).map(publicTask) }, { responseMode });
    }
    const page = await listTasksPage(root, args);
    // Filter and page before projecting public receipts; classify the sliced
    // window only. Stored task.v1 bytes stay unmodified.
    const windowTasks = projectSupervisorTaskRecords(page.tasks);
    if (page.detail === 'compact') {
      const compactTasks = windowTasks.map((t) => compactTaskCard(t));
      return result({ tasks: compactTasks, next_cursor: page.next_cursor, has_more: page.has_more, detail: page.detail, total: page.total, limit: page.limit }, { responseMode });
    }
    return result({ tasks: windowTasks.map(publicTask), next_cursor: page.next_cursor, has_more: page.has_more, detail: page.detail, total: page.total, limit: page.limit }, { responseMode });
  }
  if (name === 'cancel') return result({ task: publicTask(await cancelTask(root, args.task_id)) }, { responseMode });
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'unknown_tool' });
}
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const nativeConsent = createNativeConsentTransport({
  send,
  getCapabilities: () => clientCapabilities,
  getProtocolVersion: () => negotiated,
});

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  if (nativeConsent.handleMessage(message)) return;
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'notifications/cancelled') {
    const requestId = message.params?.requestId ?? message.params?.id;
    nativeConsent.cancelRequest(requestId);
    inflight.get(requestId)?.abort();
    return;
  }
  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    negotiated = PROTOCOLS.has(requested) ? requested : '2025-11-25';
    clientCapabilities = message.params?.capabilities ?? null;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: negotiated,
        capabilities: serverCapabilities(),
        serverInfo: { name: 'codex-co-engineer', title: 'Codex-Co-Engineer', version: VERSION },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: advertisedTools() } });
    return;
  }
  if (message.method === 'resources/list') {
    const listed = listExperienceUiResourcesForClient({
      clientCapabilities,
      resources: uiResources(),
    });
    if (listed == null) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result: { resources: listed } });
    return;
  }
  if (message.method === 'resources/read') {
    if (!clientAdvertisesCompatibleAppsUi(clientCapabilities)) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    const resource = readExperienceUiResourceForClient(message.params?.uri, {
      clientCapabilities,
      resources: uiResources(),
    });
    if (resource == null) {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: MCP_RESOURCE_NOT_FOUND, message: 'Resource not found' },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        contents: [{
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.text,
        }],
      },
    });
    return;
  }
  if (message.method === 'tools/call') {
    const controller = new AbortController();
    if (message.id !== undefined) inflight.set(message.id, controller);
    const { responseMode, args } = takePresentationArgs(message.params?.arguments ?? {});
    let response;
    try {
      response = await callTool(message.params?.name, args, {
        signal: controller.signal,
        responseMode,
      });
    } catch (error) {
      response = errorResult(error, { responseMode });
    } finally {
      inflight.delete(message.id);
    }
    send({ jsonrpc: '2.0', id: message.id, result: response });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
// A newly spawned stdio server can otherwise exit before its parent has time
// to write the first JSON-RPC frame when the pipe is initially empty.
process.stdin.resume();
input.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  handle(message).catch((error) => {
    if (message?.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message ?? 'Internal error' } });
  });
});
input.on('close', () => {
  nativeConsent.close('disconnect');
});
