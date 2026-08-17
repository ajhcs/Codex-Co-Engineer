#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { CursorApiClient, CursorApiError, DEFAULT_API_ORIGIN, defaultApiKeyFile, loadApiKey } from './client.mjs';
import { saveArtifact, maxArtifactBytes } from './artifacts.mjs';
import { SubmissionLedger, requestDigest } from './ledger.mjs';
import { redactError, redactValue } from './redaction.mjs';
import { consumeSse } from './sse.mjs';
import {
  InputError,
  TOOL_SCHEMAS,
  assertSafeArtifactPath,
  isTerminalRunStatus,
  validateToolInput,
} from './validation.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2024-11-05']);
export const SERVER_IDENTITY = Object.freeze({ name: 'cursor-cloud-control', version: '0.1.1' });
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOOL_DESCRIPTIONS = Object.freeze({
  status: 'Show local Cursor Cloud Control configuration, or perform one safe read-only identity/models/repositories discovery action.',
  agents: 'List, inspect, or create typed Cursor Cloud Agents. Creation defaults to plan mode, a new branch, and no pull request.',
  runs: 'List, inspect, follow up, wait for, stream, or cancel one exact Cursor Cloud Agent run.',
  artifacts: 'List agent artifacts or download one exact artifact to an administrator-configured owner-only local root.',
  usage: 'Read token usage for one exact Cursor Cloud Agent, optionally scoped to one run.',
  lifecycle: 'Archive, unarchive, or permanently delete one exact Cursor Cloud Agent. Deletion requires exact confirmation.',
});

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

function stateDirectory(env = process.env) {
  return path.resolve(env.CURSOR_CLOUD_CONTROL_STATE_DIR
    ?? path.join(env.XDG_STATE_HOME ?? path.join(env.HOME ?? '.', '.local', 'state'), 'cursor-cloud-control'));
}

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

function successResult(payload) {
  return { ok: true, ...payload };
}

export class CursorCloudService {
  constructor({ env = process.env, client, ledger, fetchImpl } = {}) {
    this.env = env;
    this.client = client ?? null;
    this.fetchImpl = fetchImpl;
    this.ledger = ledger ?? new SubmissionLedger({ stateDir: stateDirectory(env) });
    this.apiKey = undefined;
    this.transientSecrets = [];
  }

  async getClient() {
    if (this.client) return this.client;
    if (this.apiKey === undefined) this.apiKey = await loadApiKey(this.env, { pluginRoot: PLUGIN_ROOT });
    this.client = new CursorApiClient({
      apiKey: this.apiKey,
      origin: this.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
      authScheme: this.env.CURSOR_API_AUTH_SCHEME ?? 'bearer',
      fetchImpl: this.fetchImpl,
    });
    return this.client;
  }

  secrets() { return [...(this.client?.secrets ?? (this.apiKey ? [this.apiKey] : [])), ...this.transientSecrets]; }

  clearTransientSecrets() { this.transientSecrets = []; }

  async status(value) {
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
    const local = {
      apiVersion: 'v1',
      apiOrigin: this.env.CURSOR_API_ORIGIN ?? DEFAULT_API_ORIGIN,
      authScheme: String(this.env.CURSOR_API_AUTH_SCHEME ?? 'bearer').toLowerCase(),
      credentials: { configured, source: configuredByEnvironment ? 'environment' : (configuredFile ? 'owner-only-file' : 'none') },
      state: { directory: stateDirectory(this.env), durableLedger: true, plaintextSensitiveInputs: false },
      artifacts: { configuredRoot: artifactRootConfigured(this.env), automaticExecution: false },
      safety: { modeDefault: 'plan', workOnCurrentBranchDefault: false, autoCreatePRDefault: false, retryMutations: false },
      documentation: { checkedDate: '2026-08-16', api: 'https://cursor.com/docs/cloud-agent/api/endpoints' },
    };
    if (action === 'local') return successResult({ status: local });
    const client = await this.getClient();
    if (action === 'identity') return successResult({ identity: redactValue(await client.me(), this.secrets()) });
    if (action === 'models') return successResult({ models: redactValue(pageResult(await client.models(), value.limit), this.secrets()) });
    if (action === 'repositories') {
      try {
        return successResult({
          repositories: redactValue(pageResult(await client.repositories(), value.limit), this.secrets()),
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

  async agents(value) {
    const client = await this.getClient();
    if (value.action === 'list') {
      const response = await client.listAgents({ limit: value.limit, cursor: value.cursor, prUrl: value.prUrl, includeArchived: value.includeArchived });
      return successResult({ agents: redactValue(pageResult(response, value.limit), this.secrets()) });
    }
    if (value.action === 'get') return successResult({ agent: redactValue(await client.getAgent(value.agentId), this.secrets()) });

    const requestId = value.requestId;
    const previous = await this.ledger.lookup(requestId);
    const agentId = value.envVars !== undefined
      ? undefined
      : (value.agentId ?? previous?.agentId ?? `bc-${randomUUID()}`);
    const body = mapCreateBody(value, agentId);
    const digest = requestDigest('create-agent', body);
    const began = await this.ledger.begin({ requestId, kind: 'create-agent', digest, agentId });
    if (began.duplicate) {
      return successResult({ receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? null } });
    }
    try {
      const response = await client.createAgent(body);
      const agent = response?.agent ?? null;
      const run = response?.run ?? null;
      await this.ledger.complete(requestId, { agentId: agent?.id ?? agentId, runId: run?.id ?? null });
      return successResult({
        receipt: { requestId, requestDigest: digest, duplicate: false, status: 'submitted', agentId: agent?.id ?? agentId, runId: run?.id ?? null, effectiveConfiguration: effectiveCreateConfiguration(value) },
        agent: redactValue(agent, this.secrets()),
        run: redactValue(run, this.secrets()),
      });
    } catch (error) {
      if (isAmbiguous(error) || error?.code === 'conflict') {
        await this.ledger.uncertain(requestId, { agentId });
        const reconciliation = agentId ? `agent ID ${agentId}` : 'agent listing and the request ledger';
        throw new CursorApiError('uncertain_submission', `Cursor may have accepted the create request but the response was not confirmed; reconcile via ${reconciliation} before retrying.`, { ambiguous: true });
      }
      throw error;
    }
  }

  async runs(value) {
    const client = await this.getClient();
    if (value.action === 'list') {
      const response = await client.listRuns(value.agentId, { limit: value.limit, cursor: value.cursor });
      return successResult({ runs: redactValue(pageResult(response, value.limit), this.secrets()) });
    }
    if (value.action === 'get') return successResult({ run: redactValue(await client.getRun(value.agentId, value.runId), this.secrets()) });
    if (value.action === 'cancel') return successResult({ cancelled: redactValue(await client.cancelRun(value.agentId, value.runId), this.secrets()), agentId: value.agentId, runId: value.runId });
    if (value.action === 'followup') {
      const requestId = value.requestId;
      const body = mapFollowupBody(value);
      const digest = requestDigest('followup-run', { agentId: value.agentId, body });
      const began = await this.ledger.begin({ requestId, kind: 'followup-run', digest, agentId: value.agentId });
      if (began.duplicate) return successResult({ receipt: { requestId, requestDigest: digest, duplicate: true, status: began.record.status, agentId: began.record.agentId, runId: began.record.runId ?? null } });
      try {
        const response = await client.createRun(value.agentId, body);
        const run = response?.run ?? response ?? null;
        await this.ledger.complete(requestId, { agentId: value.agentId, runId: run?.id ?? null });
        return successResult({ receipt: { requestId, requestDigest: digest, duplicate: false, status: 'submitted', agentId: value.agentId, runId: run?.id ?? null }, run: redactValue(run, this.secrets()) });
      } catch (error) {
        if (isAmbiguous(error) || error?.code === 'conflict') {
          await this.ledger.uncertain(requestId, { agentId: value.agentId });
          throw new CursorApiError('uncertain_submission', 'Cursor may have accepted the follow-up but the response was not confirmed; reconcile runs before retrying.', { ambiguous: true });
        }
        throw error;
      }
    }
    if (value.action === 'wait') {
      const timeoutMs = value.timeoutMs ?? 30_000;
      const pollMs = value.pollMs ?? 1_000;
      const deadline = Date.now() + timeoutMs;
      let run = await client.getRun(value.agentId, value.runId);
      while (!isTerminalRunStatus(run?.status) && Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        run = await client.getRun(value.agentId, value.runId);
      }
      return successResult({ agentId: value.agentId, runId: value.runId, timedOut: !isTerminalRunStatus(run?.status), run: redactValue(run, this.secrets()) });
    }
    try {
      const response = await client.streamRun(value.agentId, value.runId, { lastEventId: value.lastEventId, timeoutMs: value.timeoutMs ?? 30_000 });
      const parsed = await consumeSse(response, { maxEvents: value.maxEvents ?? 200, maxBytes: value.maxBytes ?? 500_000, timeoutMs: value.timeoutMs ?? 30_000, secrets: this.secrets() });
      return successResult({ agentId: value.agentId, runId: value.runId, stream: parsed, resumedFrom: value.lastEventId ?? null });
    } catch (error) {
      if (error?.code === 'stream_expired') {
        const run = await client.getRun(value.agentId, value.runId);
        return successResult({ agentId: value.agentId, runId: value.runId, streamExpired: true, reconciled: true, run: redactValue(run, this.secrets()) });
      }
      throw error;
    }
  }

  async artifacts(value) {
    const client = await this.getClient();
    const listed = await client.artifacts(value.agentId);
    const items = Array.isArray(listed?.items) ? listed.items : [];
    if (value.action === 'list') return successResult({ agentId: value.agentId, artifacts: redactValue({ items: items.slice(0, 200) }, this.secrets()) });
    const requestedPath = assertSafeArtifactPath(value.path);
    const found = items.find((entry) => entry?.path === requestedPath);
    if (!found) throw new CursorApiError('artifact_not_found', 'The requested artifact was not present in Cursor metadata.');
    const download = await client.artifactDownload(value.agentId, requestedPath);
    if (typeof download?.url !== 'string') throw new CursorApiError('invalid_artifact_response', 'Cursor did not return a temporary artifact URL.');
    const bytes = await client.fetchPresigned(download.url, { maxBytes: maxArtifactBytes(this.env) });
    const saved = await saveArtifact(bytes, value.destination, { env: this.env, overwrite: value.overwrite ?? false });
    return successResult({ agentId: value.agentId, artifact: { path: requestedPath, sizeBytes: found.sizeBytes ?? bytes.byteLength, downloadedBytes: bytes.byteLength, destination: saved } });
  }

  async usage(value) {
    const client = await this.getClient();
    return successResult({ agentId: value.agentId, ...(value.runId ? { runId: value.runId } : {}), usage: redactValue(await client.usage(value.agentId, value.runId), this.secrets()) });
  }

  async lifecycle(value) {
    const client = await this.getClient();
    if (value.action === 'archive') return successResult({ action: value.action, agentId: value.agentId, result: redactValue(await client.archive(value.agentId), this.secrets()) });
    if (value.action === 'unarchive') return successResult({ action: value.action, agentId: value.agentId, result: redactValue(await client.unarchive(value.agentId), this.secrets()) });
    return successResult({ action: value.action, agentId: value.agentId, irreversible: true, result: redactValue(await client.deleteAgent(value.agentId), this.secrets()) });
  }

  async call(name, rawArguments) {
    this.transientSecrets = transientSecrets(rawArguments ?? {});
    const value = validateToolInput(name, rawArguments ?? {});
    if (name === 'status') return this.status(value);
    if (name === 'agents') return this.agents(value);
    if (name === 'runs') return this.runs(value);
    if (name === 'artifacts') return this.artifacts(value);
    if (name === 'usage') return this.usage(value);
    if (name === 'lifecycle') return this.lifecycle(value);
    throw new InputError('unknown_tool', `Unknown tool ${name}.`);
  }
}

function isAmbiguous(error) {
  return error?.ambiguous === true || ['network_error', 'request_timeout', 'upstream_timeout'].includes(error?.code);
}

export async function handleToolCall(name, rawArguments, service = new CursorCloudService()) {
  try {
    const payload = await service.call(name, rawArguments);
    const result = { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    service.clearTransientSecrets();
    return result;
  } catch (error) {
    const payload = errorResult(error, service.secrets());
    service.clearTransientSecrets();
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
