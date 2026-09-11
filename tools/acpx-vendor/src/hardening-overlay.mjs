/*
 * Co-Engineer containment layer.
 *
 * The upstream ACPX bundle deliberately keeps its transport primitives small.
 * Co-Engineer runs untrusted provider processes for bounded task lifetimes, so
 * it adds a frame cap, a bounded event queue, and a contained ACP agent process
 * group at the bundle boundary. Keeping this layer here means every provider
 * using the bundled runtime gets the same limits.
 */
const CO_ENGINEER_ACPX_MAX_FRAME_BYTES = 256 * 1024;
const CO_ENGINEER_ACPX_MAX_EVENT_ITEM_BYTES = 256 * 1024;
const CO_ENGINEER_ACPX_MAX_EVENT_QUEUE_ITEMS = 512;
const CO_ENGINEER_ACPX_MAX_EVENT_QUEUE_BYTES = 4 * 1024 * 1024;
const CO_ENGINEER_ACPX_AGENT_DESCENDANTS = Symbol('co-engineer-acpx-agent-descendants');

function coEngineerAcpFrameError(agentCommand) {
  return Object.assign(
    new Error('ACP frame exceeded ' + CO_ENGINEER_ACPX_MAX_FRAME_BYTES + ' bytes for ' + agentCommand),
    { code: 'ACP_FRAME_TOO_LARGE' },
  );
}

function coEngineerAcpQueueError() {
  return Object.assign(
    new Error('ACP event queue exceeded its bounded memory limit.'),
    { code: 'ACP_EVENT_QUEUE_LIMIT' },
  );
}

function coEngineerAcpQueueSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return CO_ENGINEER_ACPX_MAX_EVENT_ITEM_BYTES + 1;
  }
}

/*
 * Replace the upstream unbounded partial-line accumulator. Complete lines are
 * checked individually so a burst of ordinary frames is not rejected merely
 * because several frames arrive in one read.
 */
createNdJsonMessageStream = function coEngineerCreateNdJsonMessageStream(agentCommand, output, input) {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  return {
    readable: new ReadableStream({
      async start(controller) {
        let content = '';
        let failed = false;
        const reader = input.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            content += textDecoder.decode(value, { stream: true });
            const lines = content.split('\n');
            content = lines.pop() ?? '';
            for (const line of lines) {
              if (Buffer.byteLength(line, 'utf8') > CO_ENGINEER_ACPX_MAX_FRAME_BYTES) {
                throw coEngineerAcpFrameError(agentCommand);
              }
              enqueueNdJsonLine(agentCommand, line, controller);
            }
            if (Buffer.byteLength(content, 'utf8') > CO_ENGINEER_ACPX_MAX_FRAME_BYTES) {
              throw coEngineerAcpFrameError(agentCommand);
            }
          }
          const trailing = textDecoder.decode();
          if (trailing) content += trailing;
          if (content) {
            if (Buffer.byteLength(content, 'utf8') > CO_ENGINEER_ACPX_MAX_FRAME_BYTES) {
              throw coEngineerAcpFrameError(agentCommand);
            }
            enqueueNdJsonLine(agentCommand, content, controller);
          }
        } catch (error) {
          failed = true;
          controller.error(error);
          await reader.cancel(error).catch(() => {});
        } finally {
          reader.releaseLock();
          if (!failed) controller.close();
        }
      },
    }),
    writable: new WritableStream({
      async write(message) {
        const content = JSON.stringify(message) + '\n';
        const writer = output.getWriter();
        try {
          await writer.write(textEncoder.encode(content));
        } finally {
          writer.releaseLock();
        }
      },
    }),
  };
};

/*
 * Replace the upstream unbounded queue. A failed queue rejects the consumer
 * immediately; the worker then closes the ACP client and kills its contained
 * agent instead of silently treating truncation as a successful turn.
 */
AsyncEventQueue = class CoEngineerAsyncEventQueue {
  items = [];
  waits = [];
  closed = false;
  error;
  bytes = 0;

  push(value) {
    if (this.closed) return;
    const bytes = coEngineerAcpQueueSize(value);
    if (
      bytes > CO_ENGINEER_ACPX_MAX_EVENT_ITEM_BYTES
      || this.items.length >= CO_ENGINEER_ACPX_MAX_EVENT_QUEUE_ITEMS
      || this.bytes + bytes > CO_ENGINEER_ACPX_MAX_EVENT_QUEUE_BYTES
    ) {
      this.fail(coEngineerAcpQueueError());
      return;
    }
    const waiter = this.waits.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.items.push({ value, bytes });
    this.bytes += bytes;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    this.items.length = 0;
    this.bytes = 0;
    for (const waiter of this.waits.splice(0)) waiter.reject(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waits.splice(0)) waiter.resolve(null);
  }

  clear() {
    this.items.length = 0;
    this.bytes = 0;
  }

  async next() {
    if (this.items.length > 0) {
      const entry = this.items.shift();
      this.bytes -= entry.bytes;
      return entry.value ?? null;
    }
    if (this.closed) {
      if (this.error) throw this.error;
      return null;
    }
    const waiter = createDeferred();
    this.waits.push(waiter);
    return waiter.promise;
  }

  async *iterate() {
    for (;;) {
      const next = await this.next();
      if (!next) return;
      yield next;
    }
  }
};

async function coEngineerRememberAgentDescendants(child) {
  if (!child?.pid) return new Map();
  const descendants = child[CO_ENGINEER_ACPX_AGENT_DESCENDANTS]
    ?? (child[CO_ENGINEER_ACPX_AGENT_DESCENDANTS] = new Map());
  if (process.platform === 'linux') {
    const processTable = coEngineerReadLinuxProcessTable();
    const root = processTable.get(child.pid);
    if (!root) {
      try {
        process.kill(child.pid, 0);
      } catch {
        return descendants;
      }
      throw new Error('Could not inspect the live ACP agent in /proc.');
    }
    const children = new Map();
    for (const identity of processTable.values()) {
      if (identity.state === 'Z') continue;
      const siblings = children.get(identity.parentPid) ?? [];
      siblings.push(identity);
      children.set(identity.parentPid, siblings);
    }
    const pending = [child.pid];
    const visited = new Set(pending);
    for (let index = 0; index < pending.length; index += 1) {
      for (const identity of children.get(pending[index]) ?? []) {
        if (visited.has(identity.pid)) continue;
        visited.add(identity.pid);
        descendants.set(identity.pid, identity.startTime);
        pending.push(identity.pid);
      }
    }
    for (const identity of processTable.values()) {
      if (identity.pid !== child.pid && identity.processGroupId === child.pid && identity.state !== 'Z') {
        descendants.set(identity.pid, identity.startTime);
      }
    }
    return descendants;
  }
  for (const pid of await listDescendantPids(child.pid)) descendants.set(pid, null);
  for (const pid of await listProcessGroupPids(child.pid)) {
    if (pid !== child.pid) descendants.set(pid, null);
  }
  return descendants;
}

function coEngineerReadLinuxProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const stateOffset = stat.lastIndexOf(')') + 2;
    if (stateOffset <= 1) throw new Error(`Malformed /proc/${pid}/stat.`);
    const fields = stat.slice(stateOffset).trim().split(/\s+/u);
    const parentPid = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(parentPid) || !Number.isInteger(processGroupId) || !startTime) {
      throw new Error(`Malformed /proc/${pid}/stat.`);
    }
    return { pid, state: fields[0], parentPid, processGroupId, startTime };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw error;
  }
}

function coEngineerReadLinuxProcessTable() {
  const processes = new Map();
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const identity = coEngineerReadLinuxProcessIdentity(Number(entry.name));
    if (identity) processes.set(identity.pid, identity);
  }
  return processes;
}

function coEngineerAgentTreeAlive(child) {
  if (!child?.pid) return false;
  if (isChildProcessRunning(child)) return true;
  return coEngineerHasLivePid(child[CO_ENGINEER_ACPX_AGENT_DESCENDANTS] ?? new Map());
}

function coEngineerHasLivePid(pids) {
  for (const [pid, startTime] of pids) {
    if (process.platform === 'linux') {
      const identity = coEngineerReadLinuxProcessIdentity(pid);
      if (!identity || identity.state === 'Z' || identity.startTime !== startTime) {
        pids.delete(pid);
        continue;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      pids.delete(pid);
    }
  }
  return false;
}

async function coEngineerSignalAgentTree(child, signal) {
  if (!child?.pid) return;
  const descendants = await coEngineerRememberAgentDescendants(child);
  if (process.platform === 'win32') {
    await killWindowsProcessTree(child.pid, signal);
    for (const pid of descendants.keys()) await killWindowsProcessTree(pid, signal);
    return;
  }
  if (isChildProcessRunning(child) && hasLiveProcessGroup(child.pid)) sendSignal(-child.pid, signal);
  for (const [pid, startTime] of descendants) {
    if (process.platform === 'linux') {
      const identity = coEngineerReadLinuxProcessIdentity(pid);
      if (!identity || identity.state === 'Z' || identity.startTime !== startTime) {
        descendants.delete(pid);
        continue;
      }
    }
    sendSignal(pid, signal);
  }
}

async function coEngineerWaitForAgentTree(child, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (!coEngineerAgentTreeAlive(child)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}

function coEngineerClosedAgentEnvironment(sessionEnv) {
  const env = Object.create(null);
  if (sessionEnv == null || typeof sessionEnv !== 'object' || Array.isArray(sessionEnv)) return env;
  for (const key of Object.keys(sessionEnv)) {
    const value = sessionEnv[key];
    if (typeof key !== 'string' || typeof value !== 'string' || key.includes('\0') || value.includes('\0')) continue;
    env[key] = value;
  }
  return env;
}

/*
 * ACPX's upstream builder starts from process.env. Co-Engineer never lets
 * ambient Git/SSH/hosting/parent secrets reach Grok or Cursor Local ACP
 * children: the child environment is exactly the closed projection passed
 * as sessionOptions.env, or empty when that projection is omitted.
 */
buildAgentEnvironment = function coEngineerBuildAgentEnvironment(_authCredentials, sessionEnv) {
  return coEngineerClosedAgentEnvironment(sessionEnv);
};

AcpRuntimeManager.prototype.createClient = function coEngineerCreateClient(options) {
  const next = {
    ...options,
    closedProviderEnv: options.closedProviderEnv ?? this.options?.closedProviderEnv,
    onElicitationRequest: options.onElicitationRequest ?? this.options?.onElicitationRequest,
  };
  return this.deps.clientFactory?.(next) ?? new AcpClient(next);
};

/*
 * Advertise and handle ACP form elicitation so Grok's ask_user_question
 * tool has a structured Co-Engineer question bridge. Without this, Grok
 * reports the tool unsupported, dumps the question as ordinary result
 * text, and the lane can false-succeed with question_id null.
 */
AcpClient.prototype.initializeProtocolConnection = async function coEngineerInitializeProtocolConnection(
  connection,
  launch,
) {
  const initializePromise = connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      ...resolveClientCapabilities({
        devinAcp: launch.devinAcp,
        fs: this.options.fs !== false,
        terminal: this.options.terminal !== false,
      }),
      elicitation: { form: {} },
    },
    clientInfo: resolveClientInfo(launch.devinAcp),
  });
  const initialized = launch.geminiAcp
    ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs())
    : await initializePromise;
  await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
  return initialized;
};

AcpClient.prototype.createConnection = function coEngineerCreateConnection(stream, launch) {
  return new ClientSideConnection(() => ({
    sessionUpdate: async (params) => {
      await this.handleSessionUpdate(params);
    },
    requestPermission: async (params) => this.handlePermissionRequest(params),
    unstable_createElicitation: async (params) => this.handleElicitationRequest(params),
    extMethod: async (method) => {
      if (launch.devinAcp && isDevinRequestDiagnosticsMethod(method)) return {};
      const error = RequestError.methodNotFound(method);
      throw this.options.suppressSdkConsoleErrors || console.error(error.message), error;
    },
    readTextFile: async (params) => this.handleReadTextFile(params),
    writeTextFile: async (params) => this.handleWriteTextFile(params),
    createTerminal: async (params) => this.handleCreateTerminal(params),
    terminalOutput: async (params) => this.handleTerminalOutput(params),
    waitForTerminalExit: async (params) => this.handleWaitForTerminalExit(params),
    killTerminal: async (params) => this.handleKillTerminal(params),
    releaseTerminal: async (params) => this.handleReleaseTerminal(params),
    extNotification: async () => {},
  }), stream);
};

AcpClient.prototype.handleElicitationRequest = async function coEngineerHandleElicitationRequest(params) {
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
  if (sessionId && this.cancellingSessionIds.has(sessionId)) return { action: 'cancel' };
  const handler = this.options?.onElicitationRequest;
  if (typeof handler !== 'function') return { action: 'cancel' };
  const signal = sessionId ? this.cancellationSignalForSession(sessionId) : undefined;
  try {
    const decision = await handler({
      sessionId,
      raw: params,
      kind: 'elicitation',
    }, { signal });
    if (signal?.aborted || this.cancellingSessionIds.has(sessionId)) return { action: 'cancel' };
    if (!decision || decision.action === 'cancel') return { action: 'cancel' };
    if (decision.action === 'decline') return { action: 'decline' };
    if (decision.action === 'accept' || decision.content != null || decision.response != null) {
      return {
        action: 'accept',
        ...(decision.content != null ? { content: decision.content } : {}),
      };
    }
    return { action: 'cancel' };
  } catch {
    return { action: 'cancel' };
  }
};

/*
 * ACP agents are detached into their own POSIX process group. Terminal
 * children spawned by an agent may use their own group, so we snapshot and
 * signal descendants as well before the parent disappears.
 */
AcpClient.prototype.spawnAgentProcess = async function coEngineerSpawnAgentProcess(plan) {
  const spawnCommand = buildAgentSpawnCommand(plan.spawnCommand, plan.args, process.platform);
  const spawnedChild = spawn(spawnCommand.command, spawnCommand.args, {
    ...plan.spawnOptions,
    env: coEngineerClosedAgentEnvironment(this.options?.closedProviderEnv ?? this.options?.sessionOptions?.env),
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
  });
  spawnedChild[CO_ENGINEER_ACPX_AGENT_DESCENDANTS] = new Map();
  spawnedChild.once('exit', () => {
    void coEngineerRememberAgentDescendants(spawnedChild).catch(() => {});
  });
  try {
    await waitForSpawn$1(spawnedChild);
  } catch (error) {
    throw new AgentSpawnError(this.options.agentCommand, error);
  }
  return requireAgentStdio(spawnedChild);
};

AcpClient.prototype.terminateAgentProcess = async function coEngineerTerminateAgentProcess(child) {
  const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);
  // Descendant discovery is best-effort. A /proc inspection failure must not
  // skip stdin-end, signaling, or detach — otherwise a live ACP child keeps
  // stdio handles and pins the hosting test/worker event loop.
  try {
    await coEngineerRememberAgentDescendants(child);
  } catch (error) {
    this.log(
      'ACP descendant discovery failed before terminate: '
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  try {
    this.endAgentStdin(child);
    let exited = await coEngineerWaitForAgentTree(child, stdinCloseGraceMs);
    exited = await this.killAgentIfRunning(child, exited, 'SIGTERM', AGENT_CLOSE_TERM_GRACE_MS);
    if (!exited) {
      this.log('agent did not exit after ' + AGENT_CLOSE_TERM_GRACE_MS + 'ms; forcing SIGKILL');
      exited = await this.killAgentIfRunning(child, exited, 'SIGKILL', AGENT_CLOSE_KILL_GRACE_MS);
    }
    this.detachAgentHandles(child, !exited);
  } catch (error) {
    try { this.detachAgentHandles(child, true); } catch {}
    throw error;
  }
};

AcpClient.prototype.killAgentIfRunning = async function coEngineerKillAgentIfRunning(
  child,
  alreadyExited,
  signal,
  waitMs,
) {
  if (alreadyExited && !coEngineerAgentTreeAlive(child)) return true;
  try {
    await coEngineerSignalAgentTree(child, signal);
  } catch {
    // Fall through to the exact ChildProcess handle below.
  }
  // Exact ChildProcess.kill is identity-safe (not a recycled pid guess) and
  // covers agents that are not (yet) process-group leaders.
  if (isChildProcessRunning(child)) {
    try { child.kill(signal); } catch {}
  }
  return coEngineerWaitForAgentTree(child, waitMs);
};

/*
 * Turn deadlines must stay extensible. Upstream runPromptTurn races the prompt
 * against a fixed withTimeout; when that timer fires after any agent reply it
 * fabricates {stopReason:'end_turn',source:'session'}, which the manager
 * records as a completed turn. Co-Engineer therefore:
 *   1. races the prompt against the turn AbortSignal (worker-owned deadline)
 *   2. never promotes TimeoutError / interrupt into a synthetic end_turn
 * Session startup and bounded cleanup keep using their own withTimeout paths.
 *
 * The turn signal is propagated with AsyncLocalStorage so overlapping turns
 * (and managers) cannot overwrite each other's AbortSignal across awaits.
 * A module-global would race: turn B could steal turn A's signal, or A's
 * finally could restore a stale value while B is still awaiting.
 */
const { AsyncLocalStorage: CoEngineerAsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
const coEngineerTurnSignalStore = new CoEngineerAsyncLocalStorage();

/*
 * Upstream settles turn.result before finalizeRuntimeTurn retains (or closes)
 * the persistent client. Callers that await result then close() race an empty
 * pendingPersistentClients map, so close returns without terminating the ACP
 * agent or its detached descendants.
 *
 * Defer settlement only until retain/close finishes inside finalize, then
 * settle before queue.close(). Settling after the entire turn task (including
 * queue.close) delayed cancellation visibility for error/unsupported paths and
 * is unnecessary once retain precedes result at the finalize boundary.
 */
const CO_ENGINEER_TURN_SETTLE = Symbol('co-engineer-turn-settle');
const coEngineerOriginalRunRuntimeTurnTask = AcpRuntimeManager.prototype.runRuntimeTurnTask;
AcpRuntimeManager.prototype.runRuntimeTurnTask = function coEngineerRunRuntimeTurnTask(task) {
  const originalSettleResult = task.settleResult;
  let deferredSettlement;
  let settled = false;
  const settleIfNeeded = () => {
    if (settled || deferredSettlement === undefined) return;
    settled = true;
    originalSettleResult(deferredSettlement);
    deferredSettlement = undefined;
  };
  task.settleResult = (next) => {
    if (deferredSettlement === undefined) deferredSettlement = next;
  };
  task[CO_ENGINEER_TURN_SETTLE] = settleIfNeeded;
  return coEngineerTurnSignalStore.run(task?.input?.signal ?? null, async () => {
    try {
      await coEngineerOriginalRunRuntimeTurnTask.call(this, task);
    } finally {
      // Finalize normally settles; this covers prepare/connect failures where
      // finalize still closed the queue without a deferred payload hook.
      try {
        task[CO_ENGINEER_TURN_SETTLE]?.();
      } finally {
        delete task[CO_ENGINEER_TURN_SETTLE];
      }
    }
  });
};

AcpRuntimeManager.prototype.finalizeRuntimeTurn = async function coEngineerFinalizeRuntimeTurn(task, turn) {
  try {
    task.state.turnActive = false;
    task.input.signal?.removeEventListener('abort', task.abortHandler);
    turn?.client.clearEventHandlers();
    if (turn) {
      const retained = await this.finalizeRuntimeTurnRecord(turn);
      if (!retained) await turn.client.close().catch(() => {});
      this.activeControllers.delete(turn.record.acpxRecordId);
      this.closingActiveRecords.delete(turn.record.acpxRecordId);
    }
  } finally {
    try {
      task[CO_ENGINEER_TURN_SETTLE]?.();
    } finally {
      delete task[CO_ENGINEER_TURN_SETTLE];
      task.queue.close();
    }
  }
};

async function coEngineerAwaitPromptWithDeadline(promise, { timeoutMs, signal } = {}) {
  const hasTimeout = timeoutMs != null && timeoutMs > 0;
  const hasSignal = signal != null;
  if (!hasTimeout && !hasSignal) return await promise;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let abortTimer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortTimer) clearTimeout(abortTimer);
      if (hasSignal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      // Let session/cancel settle cooperatively before forcing a turn failure.
      // Hostile agents that ignore cancel still fail after this short grace.
      abortTimer = setTimeout(() => finish(reject, new InterruptedError()), 200);
    };
    // Observe the prompt before any early abort path so a pre-aborted signal
    // or hostile late settlement cannot become an unhandled rejection.
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal?.aborted) {
      finish(reject, new InterruptedError());
      return;
    }
    if (hasSignal) signal.addEventListener('abort', onAbort, { once: true });
    if (hasTimeout) {
      timer = setTimeout(() => finish(reject, new TimeoutError(timeoutMs)), timeoutMs);
    }
  });
}

function coEngineerSignalAbortPromise(signal) {
  if (signal == null) return null;
  if (signal.aborted) return Promise.resolve('abort');
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('abort'), { once: true });
  });
}

async function coEngineerAwaitSessionUpdatesIdle(client, signal) {
  const idle = client?.waitForSessionUpdatesIdle?.({
    idleMs: SESSION_REPLY_IDLE_MS,
    timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
  })?.catch(() => {}) ?? Promise.resolve();
  // Upstream drain can await an in-flight sessionUpdateChain past its own
  // deadline. Cap to the configured drain window and honor turn cancellation
  // so unsupported/error completion cannot pin finalize behind a stuck idle.
  const capMs = Math.max(SESSION_REPLY_IDLE_MS, SESSION_REPLY_DRAIN_TIMEOUT_MS) + 50;
  const races = [
    idle.then(() => 'idle'),
    new Promise((resolve) => setTimeout(() => resolve('cap'), capMs)),
  ];
  const abort = coEngineerSignalAbortPromise(signal);
  if (abort) races.push(abort);
  await Promise.race(races);
}

runPromptTurn = async function coEngineerRunPromptTurn(params) {
  const promptPromise = params.client.prompt(params.sessionId, params.prompt);
  const signal = params.signal ?? coEngineerTurnSignalStore.getStore();
  try {
    await params.onPromptStarted?.();
    const response = await coEngineerAwaitPromptWithDeadline(promptPromise, {
      timeoutMs: params.timeoutMs,
      signal,
    });
    await coEngineerAwaitSessionUpdatesIdle(params.client, signal);
    recordPromptResponseUsage(params.conversation, response.usage, params.promptMessageId);
    return { stopReason: response.stopReason, source: 'rpc' };
  } catch (error) {
    // Absorb late prompt settlement after interrupt/timeout; never replay.
    void promptPromise.then(() => {}, () => {});
    if (error instanceof InterruptedError) {
      return { stopReason: 'cancelled', source: 'signal' };
    }
    throw error;
  }
};
