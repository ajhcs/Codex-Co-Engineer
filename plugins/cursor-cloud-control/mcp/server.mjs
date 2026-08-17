#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { CursorApiClient, CursorApiError, DEFAULT_API_ORIGIN, defaultApiKeyFile, loadApiKey } from './client.mjs';
import { saveArtifact, maxArtifactBytes } from './artifacts.mjs';
import { SubmissionLedger, requestDigest, resolveStateDirectory } from './ledger.mjs';
import { redactError, redactValue } from './redaction.mjs';
import { consumeSse } from './sse.mjs';
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
export const SERVER_IDENTITY = Object.freeze({ name: 'cursor-cloud-control', version: '0.1.1' });
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOL_DESCRIPTIONS = Object.freeze({
  status: 'Show local Cursor Cloud Control configuration, or perform one safe read-only compact identity/models/repositories discovery action.',
  agents: 'List, inspect, or create typed Cursor Cloud Agents. Creation defaults to plan mode, a new branch, and no pull request.',
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

function artifactRootConfigured(env = process.env) {
  const value = typeof env.CURSOR_ARTIFACT_ROOT === 'string' ? env.CURSOR_ARTIFACT_ROOT.trim() : '';
  return Boolean(value && path.isAbsolute(value));
}

function effectiveCreateConfiguration(value) {
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
    model: value.model ? { id: value.model.id, parameterCount: value.model.params?.length ?? 0 } : null,
    envVarCount: value.envVars ? Object.keys(value.envVars).length : 0,
    mcpServerCount: value.mcpServers?.length ?? 0,
    customSubagentCount: value.customSubagents?.length ?? 0,
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
  const items = Array.isArray(response.items) ? response.items.slice(0, limit ?? 100) : [];
  return { items, ...(typeof response.nextCursor === 'string' ? { nextCursor: response.nextCursor } : {}) };
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
      try {
        const metadata = await lstat(fileName);
        if (metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o077) === 0) {
          configuredFile = Boolean((await readFile(fileName, 'utf8')).trim());
        }
      } catch {}
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
    if (action === 'models') return successResult({ models: redactValue(pageResult(await client.models(), value.limit), this.secrets(operation)) });
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

    const input = withMaterializedMcpServers(value, this.env, (values) => addOperationSecrets(operation, values));
    const client = await this.getClient();
    const requestId = value.requestId;
    const previous = await this.ledger.lookup(requestId);
    const agentId = value.envVars !== undefined
      ? undefined
      : (value.agentId ?? previous?.agentId ?? `bc-${randomUUID()}`);
    const body = mapCreateBody(input, agentId);
    // The generated agent ID is a submission detail, not caller intent. Keep
    // it out of the request digest so concurrent identical requests share one
    // idempotency key; an explicit caller-supplied ID remains part of intent.
    const digest = requestDigest('create-agent', mapCreateBody(value, value.agentId));
    const began = await this.ledger.begin({ requestId, kind: 'create-agent', digest, agentId });
    if (began.duplicate) {
      return successResult({ receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? null } });
    }
    let response;
    try {
      response = await client.createAgent(body);
    } catch (error) {
      if (isAmbiguous(error) || error?.code === 'conflict') {
        const fields = submissionFields(agentId);
        await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'create-agent', digest });
        const reconciliation = fields.agentId ? `agent ID ${fields.agentId}` : 'agent listing and the request ledger';
        throw uncertainSubmissionError(`Cursor may have accepted the create request but the response was not confirmed; reconcile via ${reconciliation} before retrying.`, fields);
      }
      await this.ledger.fail(requestId, { agentId: opaqueSubmissionId(agentId), failureCode: error?.code ?? 'submission_failed' });
      throw error;
    }
    const agent = response?.agent ?? null;
    const run = response?.run ?? null;
    const finalized = submissionFields(agent?.id ?? agentId, run?.id ?? null);
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
      receipt: { requestId, requestDigest: digest, duplicate: false, status: 'submitted', agentId: finalized.agentId, runId: finalized.runId, effectiveConfiguration: effectiveCreateConfiguration(value) },
      agent: redactValue(agent, this.secrets(operation)),
      run: redactValue(run, this.secrets(operation)),
    });
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
    if (value.action === 'cancel') {
      await this.requireDurableState();
      const client = await this.getClient();
      return successResult({ cancelled: redactValue(await client.cancelRun(value.agentId, value.runId), this.secrets(operation)), agentId: value.agentId, runId: value.runId });
    }
    if (value.action === 'followup') {
      const input = withMaterializedMcpServers(value, this.env, (values) => addOperationSecrets(operation, values));
      const client = await this.getClient();
      const requestId = value.requestId;
      const body = mapFollowupBody(input);
      const digest = requestDigest('followup-run', { agentId: value.agentId, body: mapFollowupBody(value) });
      const began = await this.ledger.begin({ requestId, kind: 'followup-run', digest, agentId: value.agentId });
      if (began.duplicate) return successResult({ receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? null } });
      let response;
      try {
        response = await client.createRun(value.agentId, body);
      } catch (error) {
        if (isAmbiguous(error) || error?.code === 'conflict') {
          const fields = submissionFields(value.agentId);
          await bestEffortUncertain(this.ledger, requestId, fields, { kind: 'followup-run', digest });
          throw uncertainSubmissionError('Cursor may have accepted the follow-up but the response was not confirmed; reconcile runs before retrying.', fields);
        }
        await this.ledger.fail(requestId, { agentId: opaqueSubmissionId(value.agentId), failureCode: error?.code ?? 'submission_failed' });
        throw error;
      }
      const run = response?.run ?? response ?? null;
      const finalized = submissionFields(value.agentId, run?.id ?? null);
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
      let run = await client.getRun(value.agentId, value.runId);
      while (!isTerminalRunStatus(run?.status) && Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        run = await client.getRun(value.agentId, value.runId);
      }
      return successResult({ agentId: value.agentId, runId: value.runId, timedOut: !isTerminalRunStatus(run?.status), run: redactValue(run, this.secrets(operation)) });
    }
    try {
      const client = await this.getClient();
      const response = await client.streamRun(value.agentId, value.runId, { lastEventId: value.lastEventId, timeoutMs: value.timeoutMs ?? 30_000 });
      const parsed = await consumeSse(response, { maxEvents: value.maxEvents ?? 200, maxBytes: value.maxBytes ?? 500_000, timeoutMs: value.timeoutMs ?? 30_000, secrets: this.secrets(operation) });
      return successResult({ agentId: value.agentId, runId: value.runId, stream: parsed, resumedFrom: value.lastEventId ?? null });
    } catch (error) {
      if (error?.code === 'stream_expired') {
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
    if (value.action === 'list') return successResult({ agentId: value.agentId, artifacts: redactValue({ items: items.slice(0, 200) }, this.secrets(operation)) });
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

  async lifecycle(value, operation) {
    await this.requireDurableState();
    const client = await this.getClient();
    if (value.action === 'archive') return successResult({ action: value.action, agentId: value.agentId, result: redactValue(await client.archive(value.agentId), this.secrets(operation)) });
    if (value.action === 'unarchive') return successResult({ action: value.action, agentId: value.agentId, result: redactValue(await client.unarchive(value.agentId), this.secrets(operation)) });
    return successResult({ action: value.action, agentId: value.agentId, irreversible: true, result: redactValue(await client.deleteAgent(value.agentId), this.secrets(operation)) });
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
  return error?.ambiguous === true
    || error?.retryable === true
    || ['network_error', 'request_timeout', 'upstream_timeout', 'upstream_failure'].includes(error?.code);
}

function opaqueSubmissionId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
