#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import {
  CursorApiClient,
  CursorApiError,
  DEFAULT_API_ORIGIN,
  defaultApiKeyFile,
  loadApiKey,
  readOwnerOnlyFile,
} from './client.mjs';
import { saveArtifact, maxArtifactBytes } from './artifacts.mjs';
import { SubmissionLedger, requestDigest, resolveStateDirectory } from './ledger.mjs';
import { redactError, redactValue } from './redaction.mjs';
import { consumeSse } from './sse.mjs';
import { summarizeModelCatalog, summarizeModelSelection } from './models.mjs';
import {
  InputError,
  TOOL_SCHEMAS,
  assertSafeArtifactPath,
  isTerminalRunStatus,
  materializeMcpServers,
  validateToolInput,
} from './validation.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2024-11-05']);
export const SERVER_IDENTITY = Object.freeze({ name: 'cursor-cloud-control', version: '0.4.0' });
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOL_DESCRIPTIONS = Object.freeze({
  status: 'Show local Cursor Cloud Control configuration, or perform one safe read-only compact identity/models/repositories discovery action.',
  agents: 'List, inspect, create, or explicitly reconcile typed Cursor Cloud Agents. Creation defaults to plan mode, a new branch, and no pull request.',
  runs: 'List, inspect, follow up, wait for, stream, or cancel one exact Cursor Cloud Agent run.',
  artifacts: 'List agent artifacts or download one exact artifact to an administrator-configured owner-only local root.',
  usage: 'Read token usage for one exact Cursor Cloud Agent, optionally scoped to one run.',
  lifecycle: 'Archive, unarchive, or permanently delete one exact Cursor Cloud Agent. Deletion requires exact confirmation.',
});

// Cursor's /v1/me response is provider-owned and may grow fields such as a
// display name, email address, avatar, organization, or credential metadata.
// Keep the model-facing identity contract deliberately narrower than that
// upstream response. Only provider identifiers from these exact fields are
// eligible, and values that look like contact data are rejected.
const IDENTITY_ID_KEYS = Object.freeze(['userId', 'user_id', 'id', 'accountId', 'account_id']);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function opaqueIdentityId(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  for (const key of IDENTITY_ID_KEYS) {
    const candidate = identity[key];
    if (typeof candidate === 'string' && OPAQUE_ID_PATTERN.test(candidate)) return candidate;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate)) return String(candidate);
  }
  return null;
}

export function projectIdentity(identity) {
  return {
    authenticated: true,
    userId: opaqueIdentityId(identity),
    keyStatus: 'valid',
  };
}

export const TOOLS = Object.freeze([
  {
    name: 'status', description: TOOL_DESCRIPTIONS.status, inputSchema: TOOL_SCHEMAS.status,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'agents', description: TOOL_DESCRIPTIONS.agents, inputSchema: TOOL_SCHEMAS.agents,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'runs', description: TOOL_DESCRIPTIONS.runs, inputSchema: TOOL_SCHEMAS.runs,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'artifacts', description: TOOL_DESCRIPTIONS.artifacts, inputSchema: TOOL_SCHEMAS.artifacts,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'usage', description: TOOL_DESCRIPTIONS.usage, inputSchema: TOOL_SCHEMAS.usage,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'lifecycle', description: TOOL_DESCRIPTIONS.lifecycle, inputSchema: TOOL_SCHEMAS.lifecycle,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const RECONCILIATION_404_ATTEMPTS = 2;
const RECONCILIATION_404_BACKOFF_MS = 100;
const RUN_NOT_FOUND_CONFIRMATIONS_REQUIRED = 2;

function artifactRootConfigured(env = process.env) {
  const value = typeof env.CURSOR_ARTIFACT_ROOT === 'string' ? env.CURSOR_ARTIFACT_ROOT.trim() : '';
  return Boolean(value && path.isAbsolute(value));
}

function requestedCreateConfiguration(value) {
  const autoCreatePR = value.autoCreatePR ?? false;
  return {
    mode: value.mode ?? 'plan',
    workOnCurrentBranch: value.workOnCurrentBranch ?? false,
    autoCreatePR,
    skipReviewerRequest: value.skipReviewerRequest ?? (autoCreatePR ? true : false),
    environment: value.env ? { type: value.env.type, named: Boolean(value.env.name) } : null,
    repositories: value.repos?.map((repo) => ({
      url: repo.url,
      ...(repo.startingRef ? { startingRef: repo.startingRef } : {}),
      ...(repo.prUrl ? { prUrl: repo.prUrl } : {}),
    })) ?? [],
    prompt: { textChars: value.prompt.text.length, imageCount: value.prompt.images?.length ?? 0 },
    model: summarizeModelSelection(value.model),
    envVarCount: value.envVars ? Object.keys(value.envVars).length : 0,
    mcpServerCount: value.mcpServers?.length ?? 0,
    customSubagentCount: value.customSubagents?.length ?? 0,
  };
}

function createReconciliationHints(value) {
  const repositories = value.repos?.map((repo) => requestDigest('repository-url', repo.url)) ?? [];
  return {
    nameDigest: value.name ? requestDigest('agent-name', value.name) : null,
    promptDigest: requestDigest('agent-prompt', value.prompt.text),
    modelId: value.model?.id ?? null,
    repositoryDigests: repositories,
    mode: value.mode ?? 'plan',
  };
}

function agentPromptText(agent) {
  if (typeof agent?.prompt === 'string') return agent.prompt;
  if (typeof agent?.prompt?.text === 'string') return agent.prompt.text;
  return null;
}

function agentModelId(agent) {
  if (typeof agent?.model === 'string') return agent.model;
  return typeof agent?.model?.id === 'string' ? agent.model.id : null;
}

function agentRepositories(agent) {
  const repositories = agent?.repos ?? agent?.repositories;
  if (!Array.isArray(repositories)) return null;
  return repositories.map((repo) => typeof repo === 'string' ? repo : repo?.url).filter((url) => typeof url === 'string');
}

function providerAgentMatchesHints(agent, hints) {
  if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || !hints) return false;
  if (hints.nameDigest !== null) {
    if (typeof agent.name !== 'string' || requestDigest('agent-name', agent.name) !== hints.nameDigest) return false;
  }
  if (hints.promptDigest !== null) {
    const prompt = agentPromptText(agent);
    if (prompt === null || requestDigest('agent-prompt', prompt) !== hints.promptDigest) return false;
  }
  if (hints.modelId !== null) {
    if (agentModelId(agent) !== hints.modelId) return false;
  }
  if (hints.repositoryDigests?.length > 0) {
    const repositories = agentRepositories(agent);
    if (!repositories || repositories.length !== hints.repositoryDigests.length) return false;
    const digests = repositories.map((url) => requestDigest('repository-url', url));
    if (digests.some((digest, index) => digest !== hints.repositoryDigests[index])) return false;
  }
  if (hints.mode !== null && agent.mode !== undefined && agent.mode !== hints.mode) return false;
  // A fingerprint with no provider-visible fields is not evidence of identity.
  return hints.nameDigest !== null || hints.promptDigest !== null || hints.modelId !== null || hints.repositoryDigests?.length > 0;
}

function legacyEffectiveCreateConfiguration(value) {
  return {
    ...requestedCreateConfiguration(value),
    // Kept for 0.2.x consumers that still read this field.  These values are
    // caller input and local defaults, not provider attestation.
    provenance: 'caller-derived',
    deprecated: true,
    deprecation: 'Use requestedConfiguration and providerVerification; this legacy alias is not provider-attested.',
  };
}

function providerVerification(value) {
  return {
    verification: 'unverified',
    source: 'provider-response-unavailable',
    // Cursor's documented create response currently does not attest the
    // resolved model, remote workspace head/branch, or repository checkout.
    // Keep all three unknown rather than echoing the request as proof.
    model: {
      ...summarizeModelSelection(value.model),
      verification: 'unverified',
    },
    workspace: {
      effective: null,
      effectiveKnown: false,
      effectiveSource: 'unknown',
      verification: 'unverified',
    },
    repositories: value.repos?.map((repo) => ({
      url: repo.url,
      startingRef: {
        requested: repo.startingRef ?? null,
        requestedSource: repo.startingRef === undefined ? 'provider-default' : 'caller',
        effective: null,
        effectiveKnown: false,
        effectiveSource: 'unknown',
        verification: 'unverified',
      },
      ...(repo.prUrl ? { prUrl: repo.prUrl } : {}),
    })) ?? [],
  };
}

function mapCreateBody(value, agentId) {
  const autoCreatePR = value.autoCreatePR ?? false;
  const body = {
    prompt: value.prompt,
    workOnCurrentBranch: value.workOnCurrentBranch ?? false,
    autoCreatePR,
    mode: value.mode ?? 'plan',
  };
  if (agentId !== undefined) body.agentId = agentId;
  for (const field of ['model', 'name', 'env', 'repos', 'envVars', 'mcpServers', 'customSubagents']) {
    if (value[field] !== undefined) body[field] = value[field];
  }
  if (autoCreatePR || value.skipReviewerRequest !== undefined) {
    body.skipReviewerRequest = value.skipReviewerRequest ?? true;
  }
  return body;
}

function withMaterializedMcpServers(value, env, addSecrets) {
  const materialized = materializeMcpServers(value.mcpServers, env);
  if (materialized.secrets.length > 0) addSecrets(materialized.secrets);
  if (materialized.servers === undefined) return value;
  return { ...value, mcpServers: materialized.servers };
}

function mapFollowupBody(value) {
  const body = { prompt: value.prompt };
  if (value.mcpServers !== undefined) body.mcpServers = value.mcpServers;
  if (value.mode !== undefined) body.mode = value.mode;
  return body;
}

function pageResult(response, limit) {
  if (!response || typeof response !== 'object') return { items: [] };
  const sourceItems = Array.isArray(response.items) ? response.items : [];
  const pageLimit = limit ?? 100;
  const items = sourceItems.slice(0, pageLimit);
  return {
    items,
    ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}),
    ...(response.truncated === true ? { truncated: true } : {}),
    ...(response.pageTruncated === true || sourceItems.length > pageLimit ? { pageTruncated: true } : {}),
  };
}

function errorResult(error, secrets = []) {
  const safe = redactError(error, secrets);
  return {
    ok: false,
    error: safe,
  };
}

function transientSecrets(value, key = '', sensitiveContext = false) {
  if (key === 'authEnv' || key === 'headerEnv') return [];
  if (typeof value === 'string') {
    if (sensitiveContext || key === 'text' || key === 'data' || key === 'prompt' || /env|header|secret|token|password/i.test(key)) return value ? [value] : [];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => transientSecrets(entry, key, sensitiveContext));
  if (value && typeof value === 'object') {
    const childContext = sensitiveContext || /envvars|headers|secrets|password|token/i.test(key);
    return Object.entries(value).flatMap(([childKey, childValue]) => transientSecrets(childValue, childKey, childContext));
  }
  return [];
}

function createOperationContext(rawArguments) {
  return { transientSecrets: transientSecrets(rawArguments ?? {}) };
}

function addOperationSecrets(operation, values) {
  if (!operation) return;
  for (const value of values ?? []) {
    if (typeof value === 'string' && value.length > 0 && !operation.transientSecrets.includes(value)) {
      operation.transientSecrets.push(value);
    }
  }
}

function successResult(payload) {
  return { ok: true, ...payload };
}

function derivedRequestId(kind, value) {
  return `auto-${requestDigest(kind, value).slice(0, 56)}`;
}

function mutationReceipt(requestId, digest, record, extra = {}) {
  return {
    requestId,
    requestDigest: digest,
    duplicate: false,
    status: record?.status ?? 'completed',
    agentId: record?.agentId ?? null,
    runId: record?.runId ?? null,
    ...extra,
  };
}

export class CursorCloudService {
  constructor({ env = process.env, client, ledger, fetchImpl } = {}) {
    this.env = env;
    this.client = client ?? null;
    this.fetchImpl = fetchImpl;
    const state = resolveStateDirectory(env);
    this.ledger = ledger ?? new SubmissionLedger({ stateDir: state.directory, source: state.source, reason: state.reason });
    this.apiKey = undefined;
  }

  async getClient() {
    if (!this.client) {
      if (this.apiKey === undefined) this.apiKey = await loadApiKey(this.env, { pluginRoot: PLUGIN_ROOT });
      this.client = new CursorApiClient({
        apiKey: this.apiKey,
        origin: this.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
        authScheme: this.env.CURSOR_API_AUTH_SCHEME ?? 'bearer',
        fetchImpl: this.fetchImpl,
      });
    }
    // CursorApiClient defers credential validation until its first request.
    // Validate before a mutation reserves an idempotency record, so missing
    // credentials or invalid local client configuration cannot strand pending.
    if (typeof this.client.authHeader === 'function') this.client.authHeader();
    return this.client;
  }

  secrets(operation) {
    return [
      ...(this.client?.secrets ?? (this.apiKey ? [this.apiKey] : [])),
      ...(operation?.transientSecrets ?? []),
    ];
  }

  async requireDurableState() {
    const readiness = await this.ledger.readiness();
    if (!readiness.ready) {
      throw new CursorApiError(readiness.code ?? 'ledger_unavailable', readiness.reason ?? 'Durable submission state is unavailable.');
    }
    return readiness;
  }

  async status(value, operation) {
    const action = value.action ?? 'local';
    const configuredByEnvironment = typeof this.env.CURSOR_API_KEY === 'string' && this.env.CURSOR_API_KEY.trim().length > 0;
    let configuredFile = false;
    if (!configuredByEnvironment) {
      const fileName = typeof this.env.CURSOR_API_KEY_FILE === 'string' && this.env.CURSOR_API_KEY_FILE.trim()
        ? this.env.CURSOR_API_KEY_FILE.trim()
        : defaultApiKeyFile(this.env);
      try { configuredFile = Boolean(await readOwnerOnlyFile(fileName, { emptyIsMissing: true })); } catch {}
    }
    const configured = configuredByEnvironment || configuredFile;
    const readiness = await this.ledger.readiness();
    const local = {
      apiVersion: 'v1',
      apiOrigin: this.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
      authScheme: String(this.env.CURSOR_API_AUTH_SCHEME ?? 'bearer').toLowerCase(),
      credentials: { configured, source: configuredByEnvironment ? 'environment' : (configuredFile ? 'owner-only-file' : 'none') },
      state: {
        directory: readiness.directory,
        ready: readiness.ready,
        source: readiness.source,
        durability: readiness.durability,
        durableLedger: readiness.ready,
        plaintextSensitiveInputs: false,
        ...(readiness.reason ? { reason: readiness.reason, reasonCode: readiness.code } : {}),
      },
      artifacts: { configuredRoot: artifactRootConfigured(this.env), automaticExecution: false },
      safety: { modeDefault: 'plan', workOnCurrentBranchDefault: false, autoCreatePRDefault: false, retryMutations: false },
      documentation: { checkedDate: '2026-08-16', api: 'https://cursor.com/docs/cloud-agent/api/endpoints' },
    };
    if (action === 'local') return successResult({ status: local });
    const client = await this.getClient();
    if (action === 'identity') return successResult({ identity: projectIdentity(await client.me()) });
    if (action === 'models') {
      const catalog = await client.models({ forceRefresh: value.refresh === true });
      const models = value.detail === true
        ? pageResult(catalog, value.limit)
        : summarizeModelCatalog(catalog, { limit: value.limit });
      return successResult({ models: redactValue(models, this.secrets(operation)) });
    }
    if (action === 'repositories') {
      try {
        return successResult({
          repositories: redactValue(pageResult(await client.repositories(), value.limit), this.secrets(operation)),
          available: true,
        });
      } catch (error) {
        if (error?.retryable === true
          || ['network_error', 'request_timeout', 'upstream_timeout', 'rate_limited', 'upstream_failure'].includes(error?.code)) {
          return successResult({
            repositories: { items: [] },
            available: false,
            reason: error.code,
            note: 'Cursor repository discovery is slow and strictly rate-limited; use a confirmed GitHub URL directly instead of blocking agent creation on inventory discovery.',
          });
        }
        throw error;
      }
    }
    throw new InputError('invalid_input', `Unsupported status action ${action}.`);
  }

  async agents(value, operation) {
    if (value.action === 'list') {
      const client = await this.getClient();
      const response = await client.listAgents({ limit: value.limit, cursor: value.cursor, prUrl: value.prUrl, includeArchived: value.includeArchived });
      return successResult({ agents: redactValue(pageResult(response, value.limit), this.secrets(operation)) });
    }
    if (value.action === 'get') {
      const client = await this.getClient();
      return successResult({ agent: redactValue(await client.getAgent(value.agentId), this.secrets(operation)) });
    }
    if (value.action === 'reconcile') return this.reconcileAgent(value, operation);

    const input = withMaterializedMcpServers(value, this.env, (values) => addOperationSecrets(operation, values));
    const client = await this.getClient();
    const requestId = value.requestId;
    // Cursor assigns an ID when the caller omits agentId. Keep the local
    // reservation provider-neutral and only forward an ID that the caller
    // explicitly supplied.
    const agentId = value.agentId ?? null;
    const body = mapCreateBody(input, value.agentId);
    // The provider ID is caller intent only when explicitly supplied; the
    // stable request ID remains the local idempotency key for omitted IDs.
    const digest = requestDigest('create-agent', mapCreateBody(value, value.agentId));
    const reconciliationHints = createReconciliationHints(value);
    const reconciliationFingerprint = requestDigest('create-agent-reconciliation', reconciliationHints);
    const began = await this.ledger.begin({
      requestId,
      kind: 'create-agent',
      digest,
      agentId,
      providerAgentId: value.agentId ?? null,
      reconciliationFingerprint,
      reconciliationHints,
    });
    if (began.duplicate) {
      return successResult({ receipt: {
        requestId,
        requestDigest: digest,
        duplicate: true,
        status: began.record.status,
        agentId: began.record.agentId,
        runId: began.record.runId ?? null,
        requestedConfiguration: requestedCreateConfiguration(value),
        effectiveConfiguration: legacyEffectiveCreateConfiguration(value),
        providerVerification: providerVerification(value),
      } });
    }
    let response;
    try {
      response = await client.createAgent(body);
    } catch (error) {
      if (isAmbiguous(error)) {
        const fields = {
          ...submissionFields(value.agentId ?? null),
          ...providerErrorField(error),
          reconciliationHints,
          reconciliationFingerprint,
        };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'create-agent', digest });
        const reconciliation = fields.agentId ? `agent ID ${fields.agentId}` : 'agent listing and the request ledger';
        throw uncertainSubmissionError(`Cursor may have accepted the create request but the response was not confirmed; reconcile via ${reconciliation} before retrying.`, fields);
      }
      await this.ledger.fail(requestId, {
        agentId: opaqueSubmissionId(agentId),
        failureCode: error?.code ?? 'submission_failed',
        ...providerErrorField(error),
      });
      throw withProviderCode(error);
    }
    const agent = response?.agent ?? null;
    const run = response?.run ?? null;
    // A caller-supplied ID is an intent constraint, not proof that Cursor
    // accepted the create. Finalize only when the 2xx response itself carries
    // an opaque provider agent ID; an empty or malformed success response must
    // remain uncertain even for explicit-ID creates.
    const providerAgentId = opaqueSubmissionId(agent?.id ?? null);
    if (!providerAgentId) {
      const fields = {
        ...submissionFields(null, run?.id ?? null),
        reconciliationHints,
        reconciliationFingerprint,
        responseShape: 'create-2xx-without-agent-id',
      };
      await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'create-agent', digest });
      throw uncertainSubmissionError(
        'Cursor returned success without a provider agent ID; the create outcome is not safe to finalize or resubmit. Reconcile the bounded provider listing or explicitly release this reservation.',
        fields,
      );
    }
    if (value.agentId !== undefined && providerAgentId !== value.agentId) {
      const fields = {
        ...submissionFields(null, run?.id ?? null),
        providerAgentId: value.agentId,
        providerReturnedAgentId: providerAgentId,
        responseShape: 'create-provider-agent-id-mismatch',
        reconciliationHints,
        reconciliationFingerprint,
      };
      await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'create-agent', digest });
      throw uncertainSubmissionError(
        'Cursor returned a provider agent ID different from the explicitly requested ID; the create outcome is not safe to finalize or resubmit. Reconcile the requested agent or explicitly release this reservation.',
        fields,
      );
    }
    // A create response may include a run object in addition to the agent.
    // The create endpoint is not allowed to attest a run belonging to some
    // other agent (or a malformed run with no identity); keep the reservation
    // uncertain until the exact provider association is proven.
    const providerRunId = opaqueSubmissionId(run?.id ?? null);
    if (run !== null && !exactProviderRunIdentity(run, providerAgentId, providerRunId)) {
      const fields = {
        ...submissionFields(providerAgentId, providerRunId),
        providerAgentId,
        ...providerRunIdentityFields(run),
        responseShape: 'create-provider-run-identity-mismatch',
        reconciliationHints,
        reconciliationFingerprint,
      };
      await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'create-agent', digest });
      throw uncertainSubmissionError(
        'Cursor returned a provider run whose identity does not exactly match the created agent; the create outcome is not safe to finalize. Reconcile the recorded agent and run or explicitly release this reservation.',
        fields,
      );
    }
    const finalized = {
      ...submissionFields(providerAgentId, providerRunId),
      providerAgentId,
    };
    try {
      await this.ledger.complete(requestId, finalized);
    } catch {
      await bestEffortUncertain(this.ledger, requestId, finalized, { kind: 'create-agent', digest });
      throw uncertainSubmissionError(
        'Cursor accepted the create request, but durable completion was not confirmed; reconcile the recorded agent and run before retrying.',
        finalized,
      );
    }
    return successResult({
      receipt: {
        requestId,
        requestDigest: digest,
        duplicate: false,
        status: 'submitted',
        agentId: finalized.agentId,
        runId: finalized.runId,
        requestedConfiguration: requestedCreateConfiguration(value),
        effectiveConfiguration: legacyEffectiveCreateConfiguration(value),
        providerVerification: providerVerification(value),
      },
      agent: redactValue(agent, this.secrets(operation)),
      run: redactValue(run, this.secrets(operation)),
    });
  }

  async reconcileAgent(value, operation) {
    await this.requireDurableState();
    const requestId = value.requestId;
    const record = await this.ledger.lookup(requestId);
    if (!record) {
      throw new CursorApiError('ledger_record_missing', 'No durable submission reservation exists for this request ID.');
    }
    if (record.kind !== 'create-agent') {
      throw new CursorApiError('reconciliation_not_supported', 'This reconciliation path is only available for uncertain agent creation reservations.');
    }

    // Reconciliation is intentionally idempotent after a local finalization.
    // Do not make another provider call for a completed reservation, and only
    // treat a failed record as already reconciled when it carries the exact
    // provider-absence marker written below.
    if (record.status === 'completed') {
      return successResult({
        requestId,
        reconciled: false,
        alreadyFinalized: true,
        status: record.status,
        agentId: record.agentId,
        runId: record.runId ?? null,
      });
    }
    if (record.status === 'failed') {
      if (record.reconciliationReason !== 'provider_not_found') {
        throw new CursorApiError('reconciliation_not_required', 'The submission does not require provider-absence reconciliation.');
      }
      return successResult({
        requestId,
        reconciled: true,
        alreadyFinalized: true,
        status: record.status,
        agentId: record.agentId,
        runId: record.runId ?? null,
      });
    }
    if (record.status === 'pending') {
      throw new CursorApiError('submission_in_progress', 'The submission is still in progress; reconcile it only after transport uncertainty is recorded.');
    }
    if (record.status !== 'uncertain') {
      throw new CursorApiError('reconciliation_not_required', 'The submission does not require provider-absence reconciliation.');
    }

    if (value.release === true) {
      if (value.confirmation !== `release:${requestId}`) {
        throw new CursorApiError('confirmation_required', `Uncertain reservation release requires confirmation exactly equal to release:${requestId}.`);
      }
      const released = await this.ledger.release(requestId, { reason: 'operator_release' });
      return successResult({
        requestId,
        reconciled: true,
        alreadyFinalized: released.duplicate,
        status: released.record.status,
        agentId: released.record.agentId,
        runId: released.record.runId ?? null,
        provider: { agent: 'unknown', reservation: 'released', reason: 'operator_release' },
      });
    }

    // New records distinguish a caller-supplied provider ID from a local
    // reservation ID. Legacy records lack providerAgentId and are treated as
    // having used their stored agentId at Cursor.
    const providerAgentId = Object.hasOwn(record, 'providerAgentId') ? record.providerAgentId : record.agentId;
    const agentId = providerAgentId;
    if (!agentId) {
      const client = await this.getClient();
      const probe = await findProviderAssignedAgent(client, record);
      // A listing fingerprint has no reservation-time provenance: an identical
      // agent may have existed before this request. Even a unique match is
      // therefore diagnostic evidence only, never proof that this create
      // produced that agent. Keep the reservation uncertain and require an
      // explicit operator release (or a provider contract with a creation
      // receipt) rather than risking attribution of a pre-existing agent.
      throw uncertainSubmissionError(
        probe.state === 'found'
          ? 'A provider agent matched the bounded fingerprint, but the listing has no reservation-time evidence proving this create produced it; the reservation remains uncertain.'
          : probe.state === 'ambiguous'
            ? 'Multiple provider agents matched the bounded reconciliation fingerprint; the reservation remains uncertain.'
            : 'No unique provider agent matched the bounded reconciliation fingerprint. The reservation remains uncertain; explicitly release it only after accepting duplicate-risk.',
        { reconciliationFingerprint: record.reconciliationFingerprint, providerListingMatch: probe.state },
      );
    }
    if (value.agentId !== undefined && value.agentId !== agentId) {
      throw new CursorApiError('reconciliation_target_mismatch', 'The provider agent ID does not match the uncertain reservation.');
    }

    const client = await this.getClient();
    const probe = await confirmProviderAgent(client, agentId);
    if (probe.state === 'absent') {
      const finalized = await this.ledger.reconcile(requestId, { agentId });
      return successResult({
        requestId,
        reconciled: true,
        alreadyFinalized: finalized.duplicate,
        status: finalized.record.status,
        agentId: finalized.record.agentId,
        runId: finalized.record.runId ?? null,
        provider: { agent: 'not_found', runs: 'not_found', reservation: 'released' },
      });
    }
    if (probe.state !== 'found') {
      throw uncertainSubmissionError(
        'Cursor agent lookup remained inconsistent after bounded repeated checks; the reservation remains uncertain.',
        { ...submissionFields(agentId), ...providerAgentIdentityFields(probe.agent) },
      );
    }
    const agent = probe.agent;

    // The provider returned an agent, so the original mutation did happen (or
    // at least an agent with the reserved ID exists). Finalize as completed;
    // never resubmit the create request. latestRunId is provider data and is
    // kept only as an opaque receipt field.
    const providerRunId = agent?.latestRunId ?? agent?.runId ?? null;
    let finalized;
    try {
      finalized = await this.ledger.complete(requestId, {
        ...submissionFields(agentId, providerRunId),
        providerAgentId: agentId,
      });
    } catch {
      await bestEffortUncertain(this.ledger, requestId, submissionFields(agentId, providerRunId), {
        kind: 'create-agent',
        digest: record.digest,
      });
      throw uncertainSubmissionError(
        'Cursor returned the reserved agent, but durable completion was not confirmed; reconcile the recorded agent again before retrying.',
        submissionFields(agentId, providerRunId),
      );
    }
    return successResult({
      requestId,
      reconciled: true,
      alreadyFinalized: false,
      status: finalized?.record?.status ?? 'completed',
      agentId,
      runId: providerRunId,
      provider: { agent: 'found', reservation: 'completed' },
    });
  }

  async reconcileRun(value, operation) {
    await this.requireDurableState();
    const requestId = value.requestId;
    const record = await this.ledger.lookup(requestId);
    if (!record) throw new CursorApiError('ledger_record_missing', 'No durable run reservation exists for this request ID.');
    if (!['followup-run', 'cancel-run'].includes(record.kind)) {
      throw new CursorApiError('reconciliation_not_supported', 'This reconciliation path only supports follow-up and cancellation reservations.');
    }
    if (record.status === 'completed') {
      return successResult({ requestId, reconciled: false, alreadyFinalized: true, status: record.status, agentId: record.agentId, runId: record.runId ?? null });
    }
    if (record.status === 'failed') {
      if (!record.reconciliationReason) throw new CursorApiError('reconciliation_not_required', 'The run reservation does not require reconciliation.');
      return successResult({ requestId, reconciled: true, alreadyFinalized: true, status: record.status, agentId: record.agentId, runId: record.runId ?? null });
    }
    if (record.status === 'pending') throw new CursorApiError('submission_in_progress', 'The run mutation is still in progress; reconcile it only after uncertainty is recorded.');
    if (record.status !== 'uncertain') throw new CursorApiError('reconciliation_not_required', 'The run reservation does not require reconciliation.');

    if (value.release === true) {
      if (value.confirmation !== `release:${requestId}`) throw new CursorApiError('confirmation_required', `Uncertain reservation release requires confirmation exactly equal to release:${requestId}.`);
      const released = await this.ledger.release(requestId, { reason: 'operator_release' });
      return successResult({ requestId, reconciled: true, alreadyFinalized: released.duplicate, status: released.record.status, agentId: released.record.agentId, runId: released.record.runId ?? null, provider: { state: 'unknown', reservation: 'released', reason: 'operator_release' } });
    }

    const agentId = record.agentId;
    if (!agentId || (value.agentId !== undefined && value.agentId !== agentId)) {
      throw new CursorApiError('reconciliation_target_mismatch', 'The provider agent ID does not match the uncertain run reservation.');
    }
    const storedRunId = record.runId ?? null;
    const targetRunId = value.runId ?? storedRunId;
    if (!targetRunId) {
      throw new CursorApiError('reconciliation_target_missing', 'A provider run ID is required to reconcile this uncertain follow-up; explicitly release the reservation if provider state cannot be proven.');
    }
    if (storedRunId && targetRunId !== storedRunId) {
      throw new CursorApiError('reconciliation_target_mismatch', 'The provider run ID does not match the uncertain run reservation.');
    }

    const client = await this.getClient();
    let run;
    try {
      run = await client.getRun(agentId, targetRunId);
    } catch (error) {
      if (error?.code !== 'not_found' || error?.status !== 404) {
        if (record.providerNotFoundConfirmations) {
          await bestEffortUncertain(this.ledger, requestId, { providerNotFoundConfirmations: 0 }, {
            kind: record.kind,
            digest: record.digest,
          });
        }
        throw error;
      }
      const confirmations = Number.isInteger(record.providerNotFoundConfirmations)
        ? record.providerNotFoundConfirmations : 0;
      const nextConfirmations = Math.min(confirmations + 1, RUN_NOT_FOUND_CONFIRMATIONS_REQUIRED);
      if (nextConfirmations < RUN_NOT_FOUND_CONFIRMATIONS_REQUIRED) {
        const fields = {
          ...submissionFields(agentId, targetRunId),
          providerNotFoundConfirmations: nextConfirmations,
        };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: record.kind, digest: record.digest });
        throw uncertainSubmissionError(
          'Cursor returned one exact 404 for the requested run; bounded repeated confirmation is required before releasing the uncertain reservation.',
          fields,
        );
      }
      const released = await this.ledger.reconcile(requestId, { agentId });
      return successResult({ requestId, reconciled: true, alreadyFinalized: released.duplicate, status: released.record.status, agentId: released.record.agentId, runId: targetRunId, provider: { state: 'not_found', reservation: 'released' } });
    }
    // A previous 404 is no longer a confirmation if any provider object is
    // returned. Completion below clears the durable observation metadata; for
    // an identity/status mismatch, reset it before retaining uncertainty so a
    // later isolated 404 cannot release this reservation.
    if (record.providerNotFoundConfirmations) {
      await bestEffortUncertain(this.ledger, requestId, { providerNotFoundConfirmations: 0 }, {
        kind: record.kind,
        digest: record.digest,
      });
    }
    if (!exactProviderRunIdentity(run, agentId, targetRunId)) {
      throw uncertainSubmissionError(
        'Cursor returned a run whose identity does not exactly match the requested agent and run; the reservation remains uncertain.',
        { ...submissionFields(agentId, targetRunId), ...providerRunIdentityFields(run) },
      );
    }
    if (record.kind === 'cancel-run') {
      const status = typeof run.status === 'string' ? run.status.toUpperCase() : '';
      if (!['CANCELLED', 'CANCELED'].includes(status)) {
        throw uncertainSubmissionError(
          'Cursor returned the targeted run, but its status does not confirm cancellation; the reservation remains uncertain.',
          { ...submissionFields(agentId, targetRunId), providerStatus: run.status ?? null },
        );
      }
    }
    const finalized = await this.ledger.complete(requestId, submissionFields(agentId, targetRunId));
    return successResult({ requestId, reconciled: true, alreadyFinalized: finalized.duplicate, status: finalized.record.status, agentId, runId: targetRunId, provider: { state: 'found', reservation: 'completed' }, run: redactValue(run, this.secrets(operation)) });
  }

  async runs(value, operation) {
    if (value.action === 'list') {
      const client = await this.getClient();
      const response = await client.listRuns(value.agentId, { limit: value.limit, cursor: value.cursor });
      return successResult({ runs: redactValue(pageResult(response, value.limit), this.secrets(operation)) });
    }
    if (value.action === 'get') {
      const client = await this.getClient();
      return successResult({ run: redactValue(await client.getRun(value.agentId, value.runId), this.secrets(operation)) });
    }
    if (value.action === 'reconcile') return this.reconcileRun(value, operation);
    if (value.action === 'cancel') {
      await this.requireDurableState();
      const client = await this.getClient();
      const requestId = value.requestId ?? derivedRequestId('cancel-run', { agentId: value.agentId, runId: value.runId });
      const digest = requestDigest('cancel-run', { agentId: value.agentId, runId: value.runId });
      const began = await this.ledger.begin({ requestId, kind: 'cancel-run', digest, agentId: value.agentId, runId: value.runId, providerAgentId: null });
      if (began.duplicate) {
        return successResult({
          receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? value.runId },
          agentId: value.agentId,
          runId: value.runId,
        });
      }
      let cancelled;
      try {
        cancelled = await client.cancelRun(value.agentId, value.runId);
      } catch (error) {
        if (isAmbiguous(error)) {
          const fields = { ...submissionFields(value.agentId, value.runId), ...providerErrorField(error) };
          await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'cancel-run', digest });
          throw uncertainSubmissionError('Cursor may have accepted the cancellation but the response was not confirmed; reconcile or explicitly release this reservation before retrying.', fields);
        }
        await this.ledger.fail(requestId, { agentId: value.agentId, runId: value.runId, failureCode: error?.code ?? 'mutation_failed', ...providerErrorField(error) });
        throw withProviderCode(error);
      }
      if (!exactProviderMutationIdentity(cancelled, { agentId: value.agentId, runId: value.runId })) {
        const fields = {
          ...submissionFields(value.agentId, value.runId),
          ...providerMutationIdentityFields(cancelled),
          responseShape: 'cancel-provider-identity-mismatch',
        };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'cancel-run', digest });
        throw uncertainSubmissionError(
          'Cursor returned a cancellation acknowledgement whose identity does not exactly match the requested agent and run; the cancellation outcome is not safe to finalize. Reconcile the recorded run or explicitly release this reservation.',
          fields,
        );
      }
      const finalized = submissionFields(value.agentId, value.runId);
      try {
        await this.ledger.complete(requestId, finalized);
      } catch {
        await bestEffortUncertain(this.ledger, requestId, finalized, { kind: 'cancel-run', digest });
        throw uncertainSubmissionError('Cursor accepted the cancellation, but durable completion was not confirmed; reconcile the recorded run before retrying.', finalized);
      }
      return successResult({
        cancelled: redactValue(cancelled, this.secrets(operation)),
        agentId: value.agentId,
        runId: value.runId,
        receipt: mutationReceipt(requestId, digest, { ...finalized, status: 'completed' }),
      });
    }
    if (value.action === 'followup') {
      const input = withMaterializedMcpServers(value, this.env, (values) => addOperationSecrets(operation, values));
      const client = await this.getClient();
      const requestId = value.requestId;
      const body = mapFollowupBody(input);
      const digest = requestDigest('followup-run', { agentId: value.agentId, body: mapFollowupBody(value) });
      const began = await this.ledger.begin({ requestId, kind: 'followup-run', digest, agentId: value.agentId, providerAgentId: value.agentId });
      if (began.duplicate) return successResult({ receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? null } });
      let response;
      try {
        response = await client.createRun(value.agentId, body);
      } catch (error) {
        if (isAmbiguous(error)) {
          const fields = { ...submissionFields(value.agentId), ...providerErrorField(error) };
          await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'followup-run', digest });
          throw uncertainSubmissionError('Cursor may have accepted the follow-up but the response was not confirmed; reconcile runs before retrying.', fields);
        }
        await this.ledger.fail(requestId, {
          agentId: opaqueSubmissionId(value.agentId),
          failureCode: error?.code ?? 'submission_failed',
          ...providerErrorField(error),
        });
        throw withProviderCode(error);
      }
      const run = response?.run ?? response ?? null;
      const runId = opaqueSubmissionId(run?.id ?? null);
      if (!runId) {
        const fields = {
          ...submissionFields(value.agentId, null),
          responseShape: 'followup-2xx-without-run-id',
        };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'followup-run', digest });
        throw uncertainSubmissionError(
          'Cursor returned success without a provider run ID; the follow-up outcome is not safe to finalize or resubmit. Reconcile the exact run or explicitly release this reservation.',
          fields,
        );
      }
      if (!exactProviderRunIdentity(run, value.agentId, runId)) {
        const fields = {
          ...submissionFields(value.agentId, runId),
          ...providerRunIdentityFields(run),
          responseShape: 'followup-provider-run-identity-mismatch',
        };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'followup-run', digest });
        throw uncertainSubmissionError(
          'Cursor returned a follow-up run whose identity does not exactly match the requested agent; the follow-up outcome is not safe to finalize. Reconcile the exact run or explicitly release this reservation.',
          fields,
        );
      }
      const finalized = submissionFields(value.agentId, runId);
      try {
        await this.ledger.complete(requestId, finalized);
      } catch {
        await bestEffortUncertain(this.ledger, requestId, finalized, { kind: 'followup-run', digest });
        throw uncertainSubmissionError(
          'Cursor accepted the follow-up, but durable completion was not confirmed; reconcile the recorded agent and run before retrying.',
          finalized,
        );
      }
      return successResult({ receipt: { requestId, requestDigest: digest, duplicate: false, status: 'submitted', agentId: finalized.agentId, runId: finalized.runId }, run: redactValue(run, this.secrets(operation)) });
    }
    if (value.action === 'wait') {
      const client = await this.getClient();
      const timeoutMs = value.timeoutMs ?? 30_000;
      const pollMs = value.pollMs ?? 1_000;
      const deadline = Date.now() + timeoutMs;
      let latestRun = null;
      let providerTimedOut = false;
      const readRun = async () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          providerTimedOut = true;
          return latestRun;
        }
        try {
          const next = await client.getRun(value.agentId, value.runId, { timeoutMs: remaining });
          if (next && typeof next === 'object') latestRun = next;
          return next ?? latestRun;
        } catch (error) {
          if (error?.code !== 'request_timeout') throw error;
          providerTimedOut = true;
          const partial = error?.run
            ?? error?.latestRun
            ?? error?.details?.run
            ?? error?.details?.latestRun
            ?? error?.details?.partial;
          if (partial && typeof partial === 'object') latestRun = partial;
          return latestRun;
        }
      };
      let run = await readRun();
      while (!providerTimedOut && !isTerminalRunStatus(run?.status) && Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        run = await readRun();
      }
      return successResult({ agentId: value.agentId, runId: value.runId, timedOut: providerTimedOut || !isTerminalRunStatus(run?.status), run: redactValue(run ?? latestRun, this.secrets(operation)) });
    }
    const client = await this.getClient();
    try {
      const response = await client.streamRun(value.agentId, value.runId, { lastEventId: value.lastEventId, timeoutMs: value.timeoutMs ?? 30_000 });
      const parsed = await consumeSse(response, {
        maxEvents: value.maxEvents ?? 200,
        maxBytes: value.maxBytes ?? 500_000,
        timeoutMs: value.timeoutMs ?? 30_000,
        lastEventId: value.lastEventId,
        secrets: this.secrets(operation),
      });
      return successResult({ agentId: value.agentId, runId: value.runId, stream: parsed, resumedFrom: value.lastEventId ?? null });
    } catch (error) {
      if (error?.code === 'stream_expired' || error?.status === 410) {
        const run = await client.getRun(value.agentId, value.runId);
        return successResult({ agentId: value.agentId, runId: value.runId, streamExpired: true, reconciled: true, run: redactValue(run, this.secrets(operation)) });
      }
      throw error;
    }
  }

  async artifacts(value, operation) {
    const client = await this.getClient();
    const listed = await client.artifacts(value.agentId);
    const items = Array.isArray(listed?.items) ? listed.items : [];
    if (value.action === 'list') {
      return successResult({
        agentId: value.agentId,
        // Keep the existing hard 200-item bound, but retain provider
        // truncation and explicitly report when this local page clipped the
        // source list.
        artifacts: redactValue(pageResult(listed, 200), this.secrets(operation)),
      });
    }
    const requestedPath = assertSafeArtifactPath(value.path);
    const found = items.find((entry) => entry?.path === requestedPath);
    if (!found) throw new CursorApiError('artifact_not_found', 'The requested artifact was not present in Cursor metadata.');
    const download = await client.artifactDownload(value.agentId, requestedPath);
    if (typeof download?.url !== 'string') throw new CursorApiError('invalid_artifact_response', 'Cursor did not return a temporary artifact URL.');
    const bytes = await client.fetchPresigned(download.url, { maxBytes: maxArtifactBytes(this.env) });
    const saved = await saveArtifact(bytes, value.destination, { env: this.env, overwrite: value.overwrite ?? false });
    return successResult({ agentId: value.agentId, artifact: { path: requestedPath, sizeBytes: found.sizeBytes ?? bytes.byteLength, downloadedBytes: bytes.byteLength, destination: saved } });
  }

  async usage(value, operation) {
    const client = await this.getClient();
    return successResult({ agentId: value.agentId, ...(value.runId ? { runId: value.runId } : {}), usage: redactValue(await client.usage(value.agentId, value.runId), this.secrets(operation)) });
  }

  async reconcileLifecycle(value, operation) {
    await this.requireDurableState();
    const requestId = value.requestId;
    const record = await this.ledger.lookup(requestId);
    if (!record) throw new CursorApiError('ledger_record_missing', 'No durable lifecycle reservation exists for this request ID.');
    if (!['lifecycle-archive', 'lifecycle-unarchive', 'lifecycle-delete'].includes(record.kind)) {
      throw new CursorApiError('reconciliation_not_supported', 'This reconciliation path only supports lifecycle reservations.');
    }
    if (record.status === 'completed') return successResult({ requestId, reconciled: false, alreadyFinalized: true, status: record.status, agentId: record.agentId });
    if (record.status === 'failed') {
      if (!record.reconciliationReason) throw new CursorApiError('reconciliation_not_required', 'The lifecycle reservation does not require reconciliation.');
      return successResult({ requestId, reconciled: true, alreadyFinalized: true, status: record.status, agentId: record.agentId });
    }
    if (record.status === 'pending') throw new CursorApiError('submission_in_progress', 'The lifecycle mutation is still in progress; reconcile it only after uncertainty is recorded.');
    if (record.status !== 'uncertain') throw new CursorApiError('reconciliation_not_required', 'The lifecycle reservation does not require reconciliation.');
    if (value.release === true) {
      if (value.confirmation !== `release:${requestId}`) throw new CursorApiError('confirmation_required', `Uncertain reservation release requires confirmation exactly equal to release:${requestId}.`);
      const released = await this.ledger.release(requestId, { reason: 'operator_release' });
      return successResult({ requestId, reconciled: true, alreadyFinalized: released.duplicate, status: released.record.status, agentId: released.record.agentId, provider: { state: 'unknown', reservation: 'released', reason: 'operator_release' } });
    }
    if (value.agentId !== undefined && value.agentId !== record.agentId) throw new CursorApiError('reconciliation_target_mismatch', 'The provider agent ID does not match the lifecycle reservation.');
    const client = await this.getClient();
    let agent;
    try {
      agent = await client.getAgent(record.agentId);
    } catch (error) {
      if (error?.code !== 'not_found' || error?.status !== 404) throw error;
      if (record.kind === 'lifecycle-delete') {
        const finalized = await this.ledger.complete(requestId, { agentId: record.agentId, providerState: 'not_found' });
        return successResult({ requestId, reconciled: true, alreadyFinalized: finalized.duplicate, status: finalized.record.status, agentId: record.agentId, provider: { state: 'not_found', reservation: 'completed' } });
      }
      const released = await this.ledger.reconcile(requestId, { agentId: record.agentId });
      return successResult({ requestId, reconciled: true, alreadyFinalized: released.duplicate, status: released.record.status, agentId: record.agentId, provider: { state: 'not_found', reservation: 'released' } });
    }
    if (!exactProviderAgentIdentity(agent, record.agentId)) {
      throw uncertainSubmissionError(
        'Cursor returned an agent whose identity does not exactly match the lifecycle target; the reservation remains uncertain.',
        { ...submissionFields(record.agentId), ...providerAgentIdentityFields(agent) },
      );
    }
    if (record.kind === 'lifecycle-delete') {
      throw uncertainSubmissionError('Cursor still returns the agent after the uncertain delete; the reservation remains uncertain.', submissionFields(record.agentId));
    }
    const archived = agent?.archived === true || String(agent?.status ?? '').toUpperCase() === 'ARCHIVED';
    const expectedArchived = record.kind === 'lifecycle-archive';
    if (archived !== expectedArchived) {
      throw uncertainSubmissionError('Cursor returned the agent, but its lifecycle state does not confirm the requested mutation; the reservation remains uncertain.', { agentId: record.agentId, archived });
    }
    const finalized = await this.ledger.complete(requestId, { agentId: record.agentId, providerState: archived ? 'archived' : 'unarchived' });
    return successResult({ requestId, reconciled: true, alreadyFinalized: finalized.duplicate, status: finalized.record.status, agentId: record.agentId, provider: { state: archived ? 'archived' : 'unarchived', reservation: 'completed' }, agent: redactValue(agent, this.secrets(operation)) });
  }

  async lifecycle(value, operation) {
    await this.requireDurableState();
    if (value.action === 'reconcile') return this.reconcileLifecycle(value, operation);
    const client = await this.getClient();
    const requestId = value.requestId ?? derivedRequestId(`lifecycle-${value.action}`, { agentId: value.agentId });
    const digest = requestDigest(`lifecycle-${value.action}`, { agentId: value.agentId });
    const kind = `lifecycle-${value.action}`;
    const began = await this.ledger.begin({ requestId, kind, digest, agentId: value.agentId, providerAgentId: null });
    if (began.duplicate) {
      return successResult({
        action: value.action,
        agentId: value.agentId,
        ...(value.action === 'delete' ? { irreversible: true } : {}),
        receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId },
      });
    }
    let result;
    try {
      if (value.action === 'archive') result = await client.archive(value.agentId);
      else if (value.action === 'unarchive') result = await client.unarchive(value.agentId);
      else result = await client.deleteAgent(value.agentId);
    } catch (error) {
      if (isAmbiguous(error)) {
        const fields = { ...submissionFields(value.agentId), ...providerErrorField(error) };
        await bestEffortUncertain(this.ledger, requestId, fields, { kind, digest });
        throw uncertainSubmissionError(`Cursor may have accepted the ${value.action} mutation but the response was not confirmed; reconcile or explicitly release this reservation before retrying.`, fields);
      }
      await this.ledger.fail(requestId, { agentId: value.agentId, failureCode: error?.code ?? 'mutation_failed', ...providerErrorField(error) });
      throw withProviderCode(error);
    }
    if (!exactProviderMutationIdentity(result, { agentId: value.agentId })) {
      const fields = {
        ...submissionFields(value.agentId),
        ...providerMutationIdentityFields(result),
        responseShape: `lifecycle-${value.action}-provider-identity-mismatch`,
      };
      await bestEffortUncertain(this.ledger, requestId, fields, { kind, digest });
      throw uncertainSubmissionError(
        `Cursor returned a ${value.action} acknowledgement whose identity does not exactly match the requested agent; the lifecycle outcome is not safe to finalize. Reconcile the exact agent or explicitly release this reservation.`,
        fields,
      );
    }
    const finalized = submissionFields(value.agentId);
    try {
      await this.ledger.complete(requestId, finalized);
    } catch {
      await bestEffortUncertain(this.ledger, requestId, finalized, { kind, digest });
      throw uncertainSubmissionError(`Cursor accepted the ${value.action} mutation, but durable completion was not confirmed; reconcile the recorded agent before retrying.`, finalized);
    }
    return successResult({
      action: value.action,
      agentId: value.agentId,
      ...(value.action === 'delete' ? { irreversible: true } : {}),
      result: redactValue(result, this.secrets(operation)),
      receipt: mutationReceipt(requestId, digest, { ...finalized, status: 'completed' }),
    });
  }

  async call(name, rawArguments, operation = createOperationContext(rawArguments)) {
    const value = validateToolInput(name, rawArguments ?? {});
    if (name === 'status') return this.status(value, operation);
    if (name === 'agents') return this.agents(value, operation);
    if (name === 'runs') return this.runs(value, operation);
    if (name === 'artifacts') return this.artifacts(value, operation);
    if (name === 'usage') return this.usage(value, operation);
    if (name === 'lifecycle') return this.lifecycle(value, operation);
    throw new InputError('unknown_tool', `Unknown tool ${name}.`);
  }
}

function isAmbiguous(error) {
  // Cursor has not accepted a mutation when it returns a conflict or rate
  // limit response. Keep those responses retryable through the failed ledger
  // state, but never claim that their transport outcome is unknown.
  if (error?.code === 'conflict' || error?.status === 409
    || error?.code === 'rate_limited' || error?.status === 429) return false;
  return error?.ambiguous === true
    || error?.retryable === true
    || ['network_error', 'request_timeout', 'upstream_timeout', 'upstream_failure', 'invalid_json', 'invalid_content_type', 'response_too_large'].includes(error?.code);
}

function providerErrorField(error) {
  const providerCode = error?.providerCode ?? error?.details?.providerCode;
  const runId = error?.providerRunId ?? error?.details?.runId ?? error?.details?.run_id;
  return {
    ...(typeof providerCode === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(providerCode) ? { providerCode } : {}),
    ...(typeof runId === 'string' && /^run-[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(runId) ? { runId } : {}),
  };
}

function withProviderCode(error) {
  const fields = providerErrorField(error);
  if (!fields.providerCode || error?.details?.providerCode === fields.providerCode) return error;
  return new CursorApiError(error?.code ?? 'internal_error', error?.message ?? 'Cursor API request failed.', {
    status: error?.status,
    details: { ...(error?.details && typeof error.details === 'object' ? error.details : {}), ...fields },
    retryable: error?.retryable === true,
    ambiguous: error?.ambiguous === true,
    providerCode: fields.providerCode,
    rateWindow: error?.rateWindow,
  });
}

function isProviderNotFound(error) {
  return error?.code === 'not_found' && error?.status === 404;
}

async function confirmProviderAgent(client, agentId) {
  let runsWereAvailable = false;
  for (let attempt = 0; attempt < RECONCILIATION_404_ATTEMPTS; attempt += 1) {
    try {
      const agent = await client.getAgent(agentId);
      if (!exactProviderAgentIdentity(agent, agentId)) return { state: 'mismatch', agent };
      return { state: 'found', agent };
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
    }

    try {
      const response = await client.listRuns(agentId, {});
      const runs = Array.isArray(response?.items) ? response.items : [];
      // A provider endpoint scoped to agentId must not be allowed to turn an
      // explicitly mismatched run into evidence that the requested agent is
      // absent. Treat malformed/mismatched list entries as inconsistent so a
      // 404 can never release the reservation on cross-agent evidence.
      if (runs.some((run) => !exactProviderRunIdentity(run, agentId, opaqueSubmissionId(run?.id ?? null)))) {
        return { state: 'mismatch', runs };
      }
      runsWereAvailable = true;
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
    }

    if (attempt + 1 < RECONCILIATION_404_ATTEMPTS) {
      await sleep(RECONCILIATION_404_BACKOFF_MS * (2 ** attempt));
    }
  }
  return runsWereAvailable ? { state: 'inconsistent' } : { state: 'absent' };
}

async function findProviderAssignedAgent(client, record) {
  const hints = record?.reconciliationHints;
  if (!hints || !record?.reconciliationFingerprint) return { state: 'unavailable' };
  const matches = [];
  let cursor;
  // Provider-assigned IDs cannot be recovered by guessing. Search only a
  // bounded number of provider pages and report exact fingerprint matches as
  // diagnostics; reservation-time provenance is required before finalization.
  for (let page = 0; page < 5; page += 1) {
    const response = await client.listAgents({ limit: 100, cursor, includeArchived: true });
    const items = Array.isArray(response?.items) ? response.items : [];
    for (const item of items) {
      if (providerAgentMatchesHints(item, hints)) matches.push(item);
    }
    const next = typeof response?.nextCursor === 'string' && response.nextCursor.length > 0
      ? response.nextCursor : null;
    if (!next || next === cursor || items.length === 0) break;
    cursor = next;
  }
  if (matches.length === 1) return { state: 'found', agent: matches[0] };
  if (matches.length > 1) return { state: 'ambiguous' };
  return { state: 'absent' };
}

function opaqueSubmissionId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isProviderRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// These identity checks are deliberately stricter than the provider endpoint
// paths. A path parameter is caller intent; only the returned object's exact
// opaque IDs can attest that reconciliation observed the requested object.
function exactProviderAgentIdentity(agent, expectedAgentId) {
  return isProviderRecord(agent)
    && typeof expectedAgentId === 'string'
    && typeof agent.id === 'string'
    && agent.id === expectedAgentId;
}

function providerRunAgentId(run) {
  if (!isProviderRecord(run)) return null;
  const values = [];
  for (const key of ['agentId', 'agent_id']) {
    if (!Object.hasOwn(run, key)) continue;
    if (typeof run[key] !== 'string' || run[key].length === 0) return null;
    values.push(run[key]);
  }
  if (values.length === 0 || values.some((value) => value !== values[0])) return null;
  return values[0];
}

function exactProviderRunIdentity(run, expectedAgentId, expectedRunId) {
  return isProviderRecord(run)
    && typeof expectedAgentId === 'string'
    && typeof expectedRunId === 'string'
    && run.id === expectedRunId
    && providerRunAgentId(run) === expectedAgentId;
}

function providerAgentIdentityFields(agent) {
  return {
    providerReturnedAgentId: opaqueSubmissionId(agent?.id ?? null),
  };
}

function providerRunIdentityFields(run) {
  return {
    providerReturnedRunId: opaqueSubmissionId(run?.id ?? null),
    providerReturnedRunAgentId: providerRunAgentId(run),
  };
}

function providerMutationIdentityFields(response) {
  return {
    ...providerAgentIdentityFields(response?.agent ?? response),
    ...providerRunIdentityFields(response?.run ?? response),
  };
}

function exactProviderMutationIdentity(response, { agentId, runId }) {
  if (response === undefined || response === null) return false;
  if (!isProviderRecord(response)) return false;

  if (Object.hasOwn(response, 'agent')) {
    if (!exactProviderAgentIdentity(response.agent, agentId)) return false;
  }
  if (Object.hasOwn(response, 'run')) {
    if (!exactProviderRunIdentity(response.run, agentId, runId ?? opaqueSubmissionId(response.run?.id ?? null))) return false;
  }

  // Mutation endpoints may return a small acknowledgement rather than the
  // full provider object (including a 204 mapped to {}). Validate every
  // identity field they do return; an empty object remains an opaque ack.
  const returnedId = Object.hasOwn(response, 'id') ? response.id
    : Object.hasOwn(response, 'runId') ? response.runId
      : undefined;
  if (returnedId !== undefined) {
    const expectedId = runId ?? agentId;
    if (returnedId !== expectedId) return false;
  }
  for (const key of ['agentId', 'agent_id']) {
    if (Object.hasOwn(response, key) && response[key] !== agentId) return false;
  }
  return true;
}

function submissionFields(agentId, runId = null) {
  return { agentId: opaqueSubmissionId(agentId), runId: opaqueSubmissionId(runId) };
}

async function bestEffortUncertain(ledger, requestId, fields, reservation) {
  try {
    await ledger.uncertain(requestId, { ...fields, ...reservation });
  } catch {
    // The durable record remains pending when this best-effort write fails;
    // the ledger's stale-pending recovery will make it uncertain later.
  }
}

function uncertainSubmissionError(message, fields) {
  return new CursorApiError('uncertain_submission', message, { ambiguous: true, details: fields });
}

export async function handleToolCall(name, rawArguments, service = new CursorCloudService()) {
  const operation = createOperationContext(rawArguments);
  try {
    const payload = await service.call(name, rawArguments, operation);
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (error) {
    const payload = errorResult(error, service.secrets(operation));
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function runStdio({ input = process.stdin, output = process.stdout, service = new CursorCloudService() } = {}) {
  let negotiated = MCP_PROTOCOL_VERSION;
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Invalid JSON.'))}\n`);
      continue;
    }
    if (message.method?.startsWith('notifications/')) continue;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      negotiated = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_IDENTITY,
        instructions: 'Cursor Cloud Control uses official Cursor Cloud Agents API v1. Credentials stay in the process environment or owner-only file; mutations are typed, bounded, and never blindly retried.',
      } })}\n`);
      continue;
    }
    if (message.method === 'ping') {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      continue;
    }
    if (message.method === 'tools/list') {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })}\n`);
      continue;
    }
    if (message.method === 'tools/call') {
      const result = await handleToolCall(message.params?.name, message.params?.arguments ?? {}, service);
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      continue;
    }
    output.write(`${JSON.stringify(jsonRpcError(message.id, -32601, `Method ${message.method ?? 'unknown'} not found.`))}\n`);
  }
}

if (process.argv.includes('--stdio')) {
  try {
    await runStdio();
  } catch (error) {
    process.stderr.write(`${redactError(error).message}\n`);
    process.exitCode = 1;
  }
}
