// Neutral fixtures for terminal-boundary lifecycle tests. Construction only:
// no Git, filesystem, process, network, provider, or stored-byte writes.

export const INCIDENT_1_TASK_ID = 'r1-w25b-rtruth-server-tasks-classifier-repair-grok-20260825';
export const INCIDENT_2_TASK_ID = 'r1-w25b-rtruth-task-store-filter-final-closure-grok-20260825';
export const SHA = 'a'.repeat(40);
export const TREE = 'b'.repeat(40);
export const OTHER_UNIT = 'codex-co-engineer-cccccccccccccccccccccccccccccccc.service';

export function lifecycleReceipt(overrides = {}) {
  const token = overrides.token ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const unit = overrides.unit ?? `codex-co-engineer-${token}.service`;
  return {
    version: 1,
    boundary: 'systemd-user-service-cgroup',
    unit,
    description: overrides.description ?? `codex-co-engineer-task:${token}`,
    invocation_id: overrides.invocation_id ?? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    control_group: overrides.control_group
      ?? `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'token')),
  };
}

export function procStat({ pid, ppid, startTicks, comm = 'wrap', state = 'S' }) {
  const fields = [state, String(ppid), '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', String(startTicks)];
  return `${pid} (${comm}) ${fields.join(' ')}`;
}

export function procStatus({ pid, nspid, state = 'S' }) {
  const ns = nspid ?? String(pid);
  const label = state === 'Z' ? 'zombie' : (state === 'X' || state === 'x' ? 'dead' : 'sleeping');
  return [
    'Name:\twrap',
    `State:\t${state} (${label})`,
    `Pid:\t${pid}`,
    `NSpid:\t${ns}`,
  ].join('\n');
}

export function incidentOneRuntime(overrides = {}) {
  const receipt = lifecycleReceipt({
    token: 'a532059d5c22478b85270de53e032013',
    invocation_id: 'ceeb644ad01c4646981369c739d008ec',
  });
  return {
    pid: 1818295,
    process_group: null,
    process_start_ticks: '579125367',
    command: 'worktree-bootstrap',
    process_boundary: receipt,
    ...overrides,
  };
}

export function incidentTwoRuntime(overrides = {}) {
  const receipt = lifecycleReceipt({
    token: 'd8cdeb77784f43329d17e1009aad7ceb',
    invocation_id: '6368455919884b0c82ce2a3fbdeaf6ce',
  });
  return {
    pid: 2394612,
    process_group: null,
    process_start_ticks: '579387325',
    command: 'worktree-bootstrap',
    process_boundary: receipt,
    ...overrides,
  };
}

export function terminalTaskRecord(overrides = {}) {
  return {
    id: overrides.id ?? 'lifecycle-one',
    status: overrides.status ?? 'completed',
    provider: 'grok',
    cwd: overrides.cwd,
    branch: overrides.branch ?? 'codex/lifecycle-one',
    start_sha: overrides.start_sha ?? SHA,
    worktree_task: overrides.worktree_task ?? overrides.id ?? 'lifecycle-one',
    workspace_kind: overrides.workspace_kind ?? 'managed-worktree',
    result: overrides.result ?? 'ok',
    finished_at: overrides.finished_at ?? '2026-08-25T20:32:28.074Z',
    handoff: overrides.handoff ?? { branch: 'codex/lifecycle-one', head: SHA },
    stop_reason: overrides.stop_reason ?? 'end_turn',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => (
      !['id', 'status', 'cwd', 'branch', 'start_sha', 'worktree_task', 'workspace_kind', 'result', 'finished_at', 'handoff', 'stop_reason'].includes(key)
    ))),
  };
}

export function gitSnapshot(overrides = {}) {
  return {
    head: overrides.head ?? SHA,
    tree: overrides.tree ?? TREE,
    branch: overrides.branch ?? 'codex/lifecycle-one',
    clean: overrides.clean !== false,
  };
}

export function createBoundaryHarness({
  receipt = lifecycleReceipt(),
  leaderPid = 4242,
  workerPid = 4300,
  startTicks = '100',
  workerTicks = '110',
  activeState = 'active',
  populated = true,
  found = true,
  invocationId,
  controlGroup,
  clearRuntimeGeneration = false,
  procErrors = {},
  cgroupErrors = {},
  extraMembers = [],
  procStates = {},
  procCgroups = {},
  procTicks = {},
  procNspid = {},
  procNs = {},
  statusErrors = {},
  procPresentWhenEmpty = {},
} = {}) {
  const unit = receipt.unit;
  const description = receipt.description;
  const invocation = invocationId ?? receipt.invocation_id;
  const cgroup = controlGroup ?? receipt.control_group;
  const state = {
    activeState,
    populated,
    found,
    forced: false,
    actions: [],
    stopCalls: 0,
    unit,
    description,
    invocationId: invocation,
    controlGroup: cgroup,
    clearRuntimeGeneration: clearRuntimeGeneration === true,
    unrelated: {
      [OTHER_UNIT]: { ActiveState: 'active', InvocationID: 'dddddddddddddddddddddddddddddddd', MainPID: '99' },
    },
  };
  const membersOf = () => (state.populated ? [leaderPid, workerPid, ...extraMembers] : []);

  const readFile = async (file) => {
    if (file.endsWith('/cgroup.events')) {
      if (cgroupErrors.events) {
        throw Object.assign(new Error('cgroup events unreadable'), { code: cgroupErrors.events });
      }
      if (!state.found && !state.populated) {
        throw Object.assign(new Error('missing cgroup'), { code: 'ENOENT' });
      }
      return `populated ${state.populated ? 1 : 0}\nfrozen 0\n`;
    }
    if (file.endsWith('/cgroup.procs')) {
      if (cgroupErrors.procs) {
        throw Object.assign(new Error('cgroup procs unreadable'), { code: cgroupErrors.procs });
      }
      return `${membersOf().join('\n')}\n`;
    }
    const procMatch = /\/proc\/(\d+)\/(stat|cgroup|status)$/u.exec(file);
    if (procMatch) {
      const pid = Number(procMatch[1]);
      const kind = procMatch[2];
      const errorCode = (kind === 'status' ? statusErrors[pid] : undefined) ?? procErrors[pid] ?? procErrors[kind];
      if (errorCode) throw Object.assign(new Error('proc unreadable'), { code: errorCode });
      const gone = !state.populated && procPresentWhenEmpty[pid] !== true && !procStates[pid] && !procCgroups[pid];
      if (gone) throw Object.assign(new Error('proc gone'), { code: 'ENOENT' });
      const memberState = procStates[pid] ?? 'S';
      const ticks = procTicks[pid] ?? (pid === leaderPid ? startTicks : workerTicks);
      if (kind === 'stat') {
        const ppid = pid === leaderPid ? 1 : leaderPid;
        return procStat({ pid, ppid, startTicks: ticks, comm: pid === leaderPid ? 'wrap' : 'node', state: memberState });
      }
      if (kind === 'status') {
        return procStatus({ pid, nspid: procNspid[pid] ?? String(pid), state: memberState });
      }
      return `0::${procCgroups[pid] ?? cgroup}\n`;
    }
    throw Object.assign(new Error(`unexpected file ${file}`), { code: 'ENOENT' });
  };

  const readlink = async (file) => {
    const match = /\/proc\/(\d+)\/ns\/pid$/u.exec(file);
    if (!match) throw Object.assign(new Error(`unexpected link ${file}`), { code: 'ENOENT' });
    const pid = Number(match[1]);
    if (procErrors[pid] || procErrors.ns) throw Object.assign(new Error('ns unreadable'), { code: procErrors[pid] ?? procErrors.ns });
    const gone = !state.populated && procPresentWhenEmpty[pid] !== true && !procStates[pid] && !procCgroups[pid];
    if (gone) throw Object.assign(new Error('proc gone'), { code: 'ENOENT' });
    return procNs[pid] ?? 'pid:[4026531836]';
  };

  const execFile = async (_command, args) => {
    state.actions.push([...args]);
    if (args.includes('list-units')) {
      return { stdout: `${OTHER_UNIT} loaded active running other\n${unit} loaded ${state.activeState} running task\n` };
    }
    if (args[1] === 'stop') {
      state.stopCalls += 1;
      state.actions.push(['stop', args.at(-1)]);
      if (args.at(-1) !== unit) {
        throw Object.assign(new Error('refusing to stop a foreign unit'), { code: 'foreign_unit' });
      }
      state.found = false;
      state.activeState = 'inactive';
      state.populated = false;
      state.clearRuntimeGeneration = true;
      state.description = state.unit;
      return { stdout: '' };
    }
    if (args[1] === 'show') {
      const target = args.find((value) => String(value).startsWith('codex-co-engineer-')) ?? state.unit;
      if (target === OTHER_UNIT) {
        const other = state.unrelated[OTHER_UNIT];
        return { stdout: [
          `Id=${OTHER_UNIT}`,
          'ActiveState=active',
          `InvocationID=${other.InvocationID}`,
          `MainPID=${other.MainPID}`,
        ].join('\n') };
      }
      if (!state.found) {
        return { stdout: [
          `Id=${state.unit}`,
          `Description=${state.unit}`,
          'LoadState=not-found',
          'ActiveState=inactive',
          'ControlGroup=',
          'KillMode=control-group',
          'InvocationID=',
          'MainPID=0',
        ].join('\n') };
      }
      const runtimeCleared = state.clearRuntimeGeneration === true;
      const shownCgroup = runtimeCleared || (state.activeState === 'inactive' && !state.populated)
        ? ''
        : state.controlGroup;
      return { stdout: [
        `Id=${state.unit}`,
        `Description=${state.description}`,
        'LoadState=loaded',
        `ActiveState=${state.activeState}`,
        `ControlGroup=${shownCgroup}`,
        'KillMode=control-group',
        `InvocationID=${runtimeCleared ? '' : state.invocationId}`,
        `MainPID=${state.populated ? leaderPid : 0}`,
      ].join('\n') };
    }
    return { stdout: '' };
  };

  const adapter = {
    platform: 'linux',
    uid: 1000,
    spawn: () => { throw new Error('launch is out of scope'); },
    execFile,
    readFile,
    readlink,
    sleep: async () => {},
  };

  return {
    adapter,
    state,
    receipt,
    leader: { pid: leaderPid, process_start_ticks: startTicks },
    workerPid,
  };
}

export function lockInspectReceipt({
  task,
  lockId = 'f0eb35fa540840c8bb4fcc7edfca2e45',
  state = 'held',
  health = 'abandoned',
  healthReason = 'wrapper process no longer exists',
  worktreePath,
  branch,
  startSha = SHA,
  wrapperPid = 1818295,
  startTicks = '579125367',
} = {}) {
  return {
    schema: 'worktree-bootstrap/v1',
    state,
    lock_id: lockId,
    task,
    worktree_path: worktreePath,
    branch,
    start_sha: startSha,
    wrapper_pid: wrapperPid,
    process_start_ticks: startTicks,
    command: ['worktree-bootstrap', 'launch', task],
    health: { state: health, abandoned: health === 'abandoned', reason: healthReason },
  };
}
