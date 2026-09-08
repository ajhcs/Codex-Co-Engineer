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
  };
  return this.deps.clientFactory?.(next) ?? new AcpClient(next);
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
  await coEngineerRememberAgentDescendants(child);
  this.endAgentStdin(child);
  let exited = await coEngineerWaitForAgentTree(child, stdinCloseGraceMs);
  exited = await this.killAgentIfRunning(child, exited, 'SIGTERM', AGENT_CLOSE_TERM_GRACE_MS);
  if (!exited) {
    this.log('agent did not exit after ' + AGENT_CLOSE_TERM_GRACE_MS + 'ms; forcing SIGKILL');
    exited = await this.killAgentIfRunning(child, exited, 'SIGKILL', AGENT_CLOSE_KILL_GRACE_MS);
  }
  this.detachAgentHandles(child, !exited);
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
    try { child.kill(signal); } catch {}
  }
  return coEngineerWaitForAgentTree(child, waitMs);
};
