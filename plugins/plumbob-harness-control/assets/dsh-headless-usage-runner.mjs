import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * Co-Engineer's managed headless runner.  The only durable product of this
 * process is a small, redacted usage receipt; stdout remains the final answer
 * so existing headless callers do not need a second protocol.
 */
export const name = 'headless-usage-runner';
export const inject = ['agentDefaultModel', 'agents', 'sessions'];
export const RECEIPT_ENV = 'CODEX_CO_ENGINEER_DSH_USAGE_RECEIPT_PATH';
export const RUNNER_ENV = 'CODEX_CO_ENGINEER_DSH_HEADLESS_USAGE_RUNNER';
export const CONTROL_JOB_ID_ENV = 'PLUMBOB_CONTROL_JOB_ID';
export const RECEIPT_SOURCE = 'dsh-headless-live';
export const CONTROL_JOB_ID_PATTERN = /^[a-z0-9-]{8,96}$/;

export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
]);
const ZERO_COUNTS = Object.freeze(Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])));
const OPEN_WRITE_BASE = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
const OWNER_ONLY_MASK = 0o077;
const MODE_MASK = 0o7777;
const JOBS_DIRECTORY_MODE = 0o700;
const RECEIPT_FILE_MODE = 0o600;
const RECEIPT_VERSION = 1;
const MAX_RECEIPT_BYTES = 64 * 1024;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function secureReceiptPlatformAvailable(options = {}) {
  const constants = Object.hasOwn(options, 'constants') ? options.constants : fsConstants;
  const getuid = Object.hasOwn(options, 'getuid') ? options.getuid : process.getuid;
  const platform = Object.hasOwn(options, 'platform') ? options.platform : process.platform;
  return platform === 'linux'
    && typeof constants?.O_NOFOLLOW === 'number'
    && typeof constants?.O_DIRECTORY === 'number'
    && typeof getuid === 'function';
}

function requireSecureReceiptPlatform() {
  if (!secureReceiptPlatformAvailable()) {
    throw new Error('receipt_platform_unsupported');
  }
}

export function validateControlJobId(jobId) {
  if (typeof jobId !== 'string' || !CONTROL_JOB_ID_PATTERN.test(jobId)) {
    throw new Error('control_job_id_invalid');
  }
  return jobId;
}

export function resolveControlJobId({ env = process.env, explicit = undefined } = {}) {
  const value = explicit === undefined ? env?.[CONTROL_JOB_ID_ENV] : explicit;
  return validateControlJobId(value);
}

function add(left, right, code = 'token_overflow') {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
    || right > Number.MAX_SAFE_INTEGER - left) {
    throw new Error(code);
  }
  return left + right;
}

function sessionId(session) {
  const id = session?.header?.id ?? session?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function parentSessionId(session) {
  const parent = session?.header?.parentSession;
  return typeof parent === 'string' && parent.length > 0 ? parent : null;
}

function sessionEvents(session) {
  return Array.isArray(session?.events) ? session.events : [];
}

function ownEventStart(session, fallback = 0) {
  const value = session?.firstLiveSeq ?? session?.header?.seedLength ?? fallback;
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function eventTurnStep(event) {
  const turn = safeCount(event?.data?.turn);
  const step = safeCount(event?.data?.step);
  return turn === null || step === null ? null : `${turn}:${step}`;
}

function usageBuckets(value) {
  if (!record(value)) return null;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const optionalCache = field === 'cacheReadTokens' || field === 'cacheWriteTokens';
    const count = value[field] === undefined && optionalCache ? 0 : safeCount(value[field]);
    if (count === null) return null;
    result[field] = count;
  }
  return result;
}

function eventUsage(event) {
  const usageEvent = event?.type === 'assistant/message'
    || (event?.type === 'assistant/chunk' && event?.data?.chunk?.type === 'usage');
  if (!usageEvent) return { state: 'none' };
  if (!record(event?.data)) return { state: 'malformed' };
  let usage;
  if (event.type === 'assistant/chunk' && event.data.chunk?.type === 'usage') {
    usage = event.data.chunk.usage;
  } else if (event.type === 'assistant/message') {
    usage = event.data.usage;
  }
  const key = eventTurnStep(event);
  const buckets = usageBuckets(usage);
  return key === null || buckets === null
    ? { state: 'malformed' }
    : { state: 'valid', key, buckets };
}

function modelFromEvent(event) {
  const sourceModel = event?.data?.message?.source?.model;
  if (typeof sourceModel === 'string' && sourceModel.length > 0) return sourceModel;
  const headerModel = event?.data?.header?.config?.model;
  return typeof headerModel === 'string' && headerModel.length > 0 ? headerModel : null;
}

/** Fold one live session without retaining prompts, content, or raw events. */
export function foldSessionUsage(session, fromSeq = ownEventStart(session)) {
  const byStep = new Map();
  const models = new Set();
  let events = 0;
  let malformedUsageEvents = 0;
  for (const event of sessionEvents(session)) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < fromSeq) continue;
    events = add(events, 1, 'event_overflow');
    const model = modelFromEvent(event);
    if (model !== null) models.add(model);
    const usage = eventUsage(event);
    if (usage.state === 'valid') byStep.set(usage.key, usage.buckets);
    else if (usage.state === 'malformed') {
      malformedUsageEvents = add(malformedUsageEvents, 1, 'malformed_usage_event_overflow');
    }
  }
  const counts = { ...ZERO_COUNTS };
  for (const buckets of byStep.values()) {
    for (const field of TOKEN_FIELDS) counts[field] = add(counts[field], buckets[field]);
  }
  return {
    counts,
    models: [...models],
    usageSamples: byStep.size,
    malformedUsageEvents,
    events,
  };
}

function liveSessions(sessions, rootSession) {
  const result = new Map();
  const rootId = sessionId(rootSession);
  if (rootId !== null) result.set(rootId, rootSession);
  if (typeof sessions?.list !== 'function') return result;
  const listed = sessions.list();
  if (!Array.isArray(listed)) return result;
  for (const session of listed) {
    const id = sessionId(session);
    if (id !== null) result.set(id, session);
  }
  return result;
}

function lineageIds(live, rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, session] of live) {
      if (ids.has(id) || !ids.has(parentSessionId(session))) continue;
      ids.add(id);
      changed = true;
    }
  }
  return ids;
}

async function flushSession(sessions, session, rootId) {
  if (typeof sessions?.flush !== 'function') return true;
  try {
    await sessions.flush(session);
    return true;
  } catch (error) {
    if (sessionId(session) === rootId) throw error;
    return false;
  }
}

function statusOf(agents, id) {
  if (typeof agents?.get !== 'function') return null;
  try {
    return agents.get(id)?.status ?? null;
  } catch {
    return null;
  }
}

/**
 * Flush and fold the root plus the live in-memory descendant tree.  A child
 * that was observed and then disposed cannot be recovered from this process,
 * so the receipt is explicitly marked incomplete instead of claiming an exact
 * account total.
 */
export async function foldLiveUsage({ rootSession, rootSessionId, rootStartSeq = 0, sessions, agents, knownDescendants = new Set() }) {
  const rootId = sessionId(rootSession);
  if (rootId === null || rootId !== rootSessionId) throw new Error('root_session_identity_mismatch');
  const known = new Set([...knownDescendants].filter((id) => typeof id === 'string' && id !== rootId));
  let live = liveSessions(sessions, rootSession);
  let selected = lineageIds(live, rootId);

  // A child may create another child while its final flush is running. Three
  // bounded passes cover the normal one-shot lifecycle without becoming a
  // wait loop controlled by provider behavior.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const id of selected) {
      const session = live.get(id);
      if (!session) continue;
      if (id !== rootId) known.add(id);
      const flushed = await flushSession(sessions, session, rootId);
      if (!flushed) known.add(id);
    }
    const next = liveSessions(sessions, rootSession);
    const nextSelected = lineageIds(next, rootId);
    const same = nextSelected.size === selected.size
      && [...nextSelected].every((id) => selected.has(id));
    live = next;
    selected = nextSelected;
    if (same) break;
  }

  const missing = [...known].filter((id) => !live.has(id));
  let aggregationComplete = missing.length === 0;
  const totals = { ...ZERO_COUNTS };
  const models = new Set();
  let usageSamples = 0;
  let malformedUsageEvents = 0;
  let events = 0;
  for (const id of selected) {
    const session = live.get(id);
    if (!session) {
      aggregationComplete = false;
      continue;
    }
    const folded = foldSessionUsage(session, id === rootId ? rootStartSeq : ownEventStart(session));
    for (const field of TOKEN_FIELDS) totals[field] = add(totals[field], folded.counts[field]);
    usageSamples = add(usageSamples, folded.usageSamples, 'usage_sample_overflow');
    malformedUsageEvents = add(
      malformedUsageEvents,
      folded.malformedUsageEvents,
      'malformed_usage_event_overflow',
    );
    if (folded.malformedUsageEvents > 0) aggregationComplete = false;
    events = add(events, folded.events, 'event_overflow');
    for (const model of folded.models) models.add(model);
    if (id !== rootId && statusOf(agents, id) === 'running') aggregationComplete = false;
  }
  const modelList = [...models].sort();
  const observed = usageSamples > 0;
  return {
    aggregationComplete,
    missingDescendantCount: missing.length,
    sessionCount: selected.size,
    descendantSessionCount: Math.max(0, selected.size - 1),
    usageSamples,
    malformedUsageEvents,
    events,
    models: modelList,
    model: modelList.length === 1 ? modelList[0] : null,
    counts: {
      ...totals,
      totalTokens: TOKEN_FIELDS.reduce((sum, field) => add(sum, totals[field]), 0),
    },
    confidence: aggregationComplete ? (observed ? 'exact' : 'unknown') : 'observed',
  };
}

function assistantText(event) {
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('');
}

function summarize(events, firstSeq) {
  let text = '';
  let streamed = '';
  let reason;
  for (const event of events) {
    if (!Number.isSafeInteger(event?.seq) || event.seq < firstSeq) continue;
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
      if (typeof event.data.chunk.text === 'string') streamed += event.data.chunk.text;
    } else if (event.type === 'assistant/message') {
      const joined = assistantText(event);
      if (joined !== '') text = joined;
    } else if (event.type === 'turn/end') {
      reason = event.data?.reason;
    }
  }
  return { text: text || streamed, reason };
}

function makeUserMessage(task) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: task }],
    source: { kind: 'user' },
  };
}

async function loadRuntime(ctx) {
  const loader = ctx?.get?.('loader');
  if (loader?.await) await loader.await();
  if (typeof loader?.import !== 'function') return {};
  const [llm, agentModule] = await Promise.all([
    loader.import('@deepseek-ai/dsh-llm'),
    loader.import('@deepseek-ai/dsh-agent'),
  ]);
  return {
    createUserMessage: llm?.createUserMessage,
    installModelSelection: agentModule?.installModelSelection,
  };
}

function observeDescendants(ctx, rootId, known, rootAgent) {
  const disposers = [];
  const on = (target, type, callback) => {
    if (typeof target?.on !== 'function') return;
    const dispose = target.on(type, callback);
    if (typeof dispose === 'function') disposers.push(dispose);
  };
  const remember = (session) => {
    const id = sessionId(session);
    const parent = parentSessionId(session);
    if (id !== null && id !== rootId && parent !== null
      && (parent === rootId || known.has(parent))) known.add(id);
  };
  on(ctx, 'session/created', remember);
  on(rootAgent?.ctx, 'subagent/start', (info) => {
    if (typeof info?.id === 'string' && info.id !== rootId) known.add(info.id);
  });
  return () => disposers.splice(0).forEach((dispose) => dispose());
}

function receiptTarget(value, jobId) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('receipt_path_invalid');
  }
  const file = path.resolve(value);
  if (file !== value) throw new Error('receipt_path_invalid');
  const directory = path.dirname(file);
  if (file !== path.join(directory, `${jobId}.usage.json`)) {
    throw new Error('receipt_target_mismatch');
  }
  return { file, directory };
}

function ownerUid() {
  requireSecureReceiptPlatform();
  let uid;
  try {
    uid = process.getuid();
  } catch {
    throw new Error('receipt_platform_unsupported');
  }
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('receipt_platform_unsupported');
  return uid;
}

function fileIdentity(metadata) {
  return { device: String(metadata.dev), inode: String(metadata.ino) };
}

function sameIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode;
}

async function assertReceiptParent(directory, expectedIdentity = null) {
  requireSecureReceiptPlatform();
  let canonical;
  try {
    canonical = await realpath(directory);
  } catch {
    throw new Error('receipt_parent_unsafe');
  }
  if (canonical !== directory) throw new Error('receipt_parent_redirected');
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || (metadata.mode & MODE_MASK) !== JOBS_DIRECTORY_MODE
    || (metadata.mode & OWNER_ONLY_MASK) !== 0) {
    throw new Error('receipt_parent_unsafe');
  }
  const uid = ownerUid();
  if (metadata.uid !== uid) throw new Error('receipt_parent_owner');
  const identity = fileIdentity(metadata);
  if (expectedIdentity !== null && !sameIdentity(expectedIdentity, identity)) {
    throw new Error('receipt_parent_replaced');
  }
  return identity;
}

async function assertDirectoryAnchor(anchor) {
  let opened;
  let viaProc;
  try {
    [opened, viaProc] = await Promise.all([
      anchor.handle.stat(),
      stat(anchor.path),
    ]);
  } catch {
    throw new Error('receipt_platform_unsupported');
  }
  const openedIdentity = fileIdentity(opened);
  const procIdentity = fileIdentity(viaProc);
  if (!opened.isDirectory()
    || !viaProc.isDirectory()
    || (opened.mode & MODE_MASK) !== JOBS_DIRECTORY_MODE
    || (viaProc.mode & MODE_MASK) !== JOBS_DIRECTORY_MODE
    || opened.uid !== ownerUid()
    || viaProc.uid !== ownerUid()
    || !sameIdentity(anchor.identity, openedIdentity)
    || !sameIdentity(anchor.identity, procIdentity)) {
    throw new Error('receipt_parent_replaced');
  }
}

async function openReceiptParent(directory) {
  requireSecureReceiptPlatform();
  const listedIdentity = await assertReceiptParent(directory);
  let handle;
  try {
    handle = await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isDirectory()
      || (opened.mode & MODE_MASK) !== JOBS_DIRECTORY_MODE
      || opened.uid !== ownerUid()
      || !sameIdentity(listedIdentity, fileIdentity(opened))) {
      throw new Error('receipt_parent_replaced');
    }
    const anchor = {
      handle,
      identity: listedIdentity,
      path: `/proc/self/fd/${handle.fd}`,
    };
    await assertDirectoryAnchor(anchor);
    await assertReceiptParent(directory, listedIdentity);
    return anchor;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === 'ELOOP') throw new Error('receipt_parent_redirected');
    throw error;
  }
}

function assertReceiptFile(metadata, expectedIdentity = null) {
  if (!metadata.isFile()
    || metadata.nlink !== 1
    || (metadata.mode & MODE_MASK) !== RECEIPT_FILE_MODE) {
    throw new Error(metadata.nlink !== 1 ? 'receipt_hardlink' : 'receipt_permissions');
  }
  if (metadata.uid !== ownerUid()) throw new Error('receipt_owner');
  const identity = fileIdentity(metadata);
  if (expectedIdentity !== null && !sameIdentity(expectedIdentity, identity)) {
    throw new Error('receipt_replaced');
  }
  return identity;
}

async function writeUsageReceiptInternal(
  receipt,
  target = process.env[RECEIPT_ENV],
  hooks = {},
) {
  requireSecureReceiptPlatform();
  if (!record(receipt)) throw new Error('receipt_invalid');
  const jobId = validateControlJobId(receipt.jobId);
  const { file, directory } = receiptTarget(target, jobId);
  const encoded = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) throw new Error('receipt_too_large');
  const anchor = await openReceiptParent(directory);
  const anchoredFile = path.join(anchor.path, path.basename(file));
  const temporary = `${anchoredFile}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    if (typeof hooks.afterParentOpen === 'function') await hooks.afterParentOpen();
    await assertDirectoryAnchor(anchor);
    handle = await open(temporary, OPEN_WRITE_BASE | fsConstants.O_NOFOLLOW, 0o600);
    await handle.chmod(RECEIPT_FILE_MODE);
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    const temporaryMetadata = await handle.stat();
    const temporaryIdentity = assertReceiptFile(temporaryMetadata);
    await assertDirectoryAnchor(anchor);
    await rename(temporary, anchoredFile);
    const renamedMetadata = await handle.stat();
    assertReceiptFile(renamedMetadata, temporaryIdentity);
    await assertDirectoryAnchor(anchor);
    const listed = await lstat(anchoredFile);
    assertReceiptFile(listed, temporaryIdentity);
    await assertReceiptParent(directory, anchor.identity);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await anchor.handle.close().catch(() => {});
  }
  return receipt;
}

/** Atomically replace one exact receipt beneath its verified jobs-directory fd. */
export async function writeUsageReceipt(receipt, target = process.env[RECEIPT_ENV]) {
  return writeUsageReceiptInternal(receipt, target);
}

export const __testing = Object.freeze({
  writeUsageReceiptWithHooks: writeUsageReceiptInternal,
});

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(io, error) {
  io.stderr.write(`dsh: ${errorText(error)}\n`);
  io.exit(1);
}

/** Execute one task and return the compact receipt for provider-free tests. */
export async function run(
  ctx,
  task,
  io = internals,
  {
    receipt = process.env[RECEIPT_ENV],
    // `jobId` is intentionally an explicit test seam. Production DSH runs
    // must use the exact control-plane environment variable below.
    jobId: explicitJobId = undefined,
  } = {},
) {
  if (typeof task !== 'string' || task.trim() === '') throw new Error('a task is required');
  const controlJobId = resolveControlJobId({ explicit: explicitJobId });
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (!agents || !defaultModel || !sessions) throw new Error('headless usage runner dependencies unavailable');
  const runtime = await loadRuntime(ctx);
  const selection = defaultModel.currentSelection();
  const rootSessionId = createRootSessionId();
  const handle = await agents.create({
    sessionId: rootSessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: runtime.installModelSelection === undefined ? undefined : (agentCtx) => {
      runtime.installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
  });
  const agent = handle?.agent;
  const rootSession = agent?.session;
  if (!agent || sessionId(rootSession) !== rootSessionId) throw new Error('root_session_identity_mismatch');
  const knownDescendants = new Set();
  const stopObserving = observeDescendants(ctx, rootSessionId, knownDescendants, agent);
  try {
    await agent.whenIdle();
    const firstSeq = Number.isSafeInteger(rootSession.seq) ? rootSession.seq : sessionEvents(rootSession).length;
    const message = runtime.createUserMessage === undefined
      ? makeUserMessage(task)
      : runtime.createUserMessage({
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      });
    agent.followup(message);
    await agent.whenIdle();
    const folded = await foldLiveUsage({
      rootSession,
      rootSessionId,
      rootStartSeq: firstSeq,
      sessions,
      agents,
      knownDescendants,
    });
    const receiptValue = {
      schemaVersion: RECEIPT_VERSION,
      source: RECEIPT_SOURCE,
      scope: 'task',
      jobId: controlJobId,
      rootSessionId,
      observedAt: new Date().toISOString(),
      aggregationComplete: folded.aggregationComplete,
      confidence: folded.confidence,
      missingDescendantCount: folded.missingDescendantCount,
      sessionCount: folded.sessionCount,
      descendantSessionCount: folded.descendantSessionCount,
      usageSamples: folded.usageSamples,
      malformedUsageEventCount: folded.malformedUsageEvents,
      events: folded.events,
      model: folded.model,
      models: folded.models,
      counts: folded.counts,
      estimatedCost: null,
      spend: null,
      accountRemaining: null,
      rateLimit: null,
    };
    await writeUsageReceipt(receiptValue, receipt);
    const outcome = summarize(sessionEvents(rootSession), firstSeq);
    io.stdout.write(`${outcome.text}\n`);
    if (outcome.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
    }
    io.exit(outcome.reason?.kind === 'completed' ? 0 : 1);
    return { rootSessionId, receipt: receiptValue, outcome };
  } finally {
    stopObserving();
  }
}

export function createRootSessionId() {
  return `session-${randomUUID()}`;
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (typeof exit !== 'function') throw new Error('headless-usage-runner: the launcher must provide ctx.appExit');
  run(ctx, config.task, { stdout: internals.stdout, stderr: internals.stderr, exit }).catch((error) => fail({ stdout: internals.stdout, stderr: internals.stderr, exit }, error));
}
