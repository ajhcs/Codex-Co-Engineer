import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ACP_RESOURCE_ENV,
  ACP_RESOURCE_LIMITS,
  AcpResourceBoundaryError,
  attestAcpSessionWorker,
  createTrustedAcpOwnershipStore,
  launchAcpResourceBoundary,
  prepareAcpResourceBoundary,
  probeAcpResourceBoundary,
  reconcileOwnedAcpResourceBoundary,
  restoreAcpResourceBoundaryOwner,
  stopAcpResourceBoundary,
} from '../mcp/acp-resource-boundary.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

class FakeAdapter {
  constructor() {
    this.platform = 'linux';
    this.uid = process.getuid();
    this.units = new Map();
    this.calls = [];
    this.spawned = null;
    this.stubborn = false;
    this.unkillable = false;
    this.spoof = null;
    this.collision = false;
    this.spawnError = null;
    this.earlyExit = false;
    this.invocationDelay = 0;
    this.showCounts = new Map();
  }

  async readText(source) {
    if (source === '/sys/fs/cgroup/cgroup.controllers') return 'cpu memory pids\n';
    if (source === '/proc/self/cgroup') return '0::/user.slice/user-1000.slice/session.scope\n';
    if (source.includes('/user@1000.service/cgroup.controllers')) return 'memory pids\n';
    if (source.endsWith('/cgroup.events')) {
      return this.stubborn ? 'populated 1\n' : 'populated 0\n';
    }
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }

  async run(executable, args) {
    this.calls.push({ executable, args: [...args] });
    if (args[1] === 'show' && args[2] === '--no-pager') {
      return { status: 0, stdout: 'Version=257\nControlGroup=/user.slice/user-1000.slice/user@1000.service\nRuntimeDirectory=/run/user/1000\n', stderr: '' };
    }
    if (executable === '/usr/bin/systemd-run' && args[0] === '--version') {
      return { status: 0, stdout: 'systemd 257 (257.1)\n', stderr: '' };
    }
    if (args[1] === 'show') {
      const unit = args[2];
      let value = this.units.get(unit);
      if (!value && this.collision) {
        value = { Id: unit, LoadState: 'loaded', ActiveState: 'active' };
      }
      if (!value) return { status: 1, stdout: 'LoadState=not-found\n', stderr: 'not found' };
      if (this.invocationDelay > 0) {
        const count = (this.showCounts.get(unit) ?? 0) + 1;
        this.showCounts.set(unit, count);
        if (count <= this.invocationDelay) value = { ...value, InvocationID: '' };
      }
      value = this.spoof ? { ...value, ...this.spoof } : value;
      return { status: 0, stdout: Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join('\n'), stderr: '' };
    }
    if (args[1] === 'kill' && args.includes('--signal=KILL') && !this.unkillable) this.stubborn = false;
    return { status: 0, stdout: '', stderr: '' };
  }

  spawn(executable, args, options) {
    const unit = args.find((arg) => arg.startsWith('--unit=')).slice(7);
    const props = Object.fromEntries(args.filter((arg) => arg.startsWith('--property='))
      .map((arg) => arg.slice(11).split(/=(.*)/su).slice(0, 2)));
    this.units.set(unit, {
      Id: unit, Description: props.Description, LoadState: 'loaded', ActiveState: 'active',
      ControlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
      MemoryMax: props.MemoryMax, MemorySwapMax: props.MemorySwapMax, TasksMax: props.TasksMax,
      KillMode: props.KillMode, TimeoutStopUSec: '5s', CollectMode: props.CollectMode,
      RuntimeMaxUSec: props.RuntimeMaxSec, Delegate: 'no',
      InvocationID: '0123456789abcdef0123456789abcdef',
    });
    this.spawned = { executable, args: [...args], options: { ...options } };
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (this.spawnError) child.emit('error', this.spawnError);
      else {
        child.emit('spawn');
        if (this.earlyExit) queueMicrotask(() => child.emit('exit', 1, null));
      }
    });
    return child;
  }

  async sleep() {}
}

async function fixture() {
  const root = await mkdtemp('/tmp/acp-boundary-test-');
  const nodePath = await realpath(process.execPath);
  const workerPath = path.join(root, 'worker.mjs');
  const source = "import { fileURLToPath } from 'node:url';\nif (process.argv[1] !== fileURLToPath(import.meta.url)) throw new Error('CLI guard failed');\nprocess.stdout.write(JSON.stringify(process.argv.slice(1)));\n";
  await writeFile(workerPath, source, { mode: 0o500 });
  await chmod(workerPath, 0o500);
  const worker = await attestAcpSessionWorker({ nodePath, workerPath, workerSha256: sha256(source), fixedArgs: ['--fixed-profile=grok-acp'] });
  const receipts = new Map();
  const ownershipStore = createTrustedAcpOwnershipStore({
    async save(id, receipt) { receipts.set(id, structuredClone(receipt)); },
    async load(id) { return structuredClone(receipts.get(id)); },
  });
  return { root, worker, ownershipStore, receipts };
}

test('probe is provider-free and reports actionable unavailable states', async () => {
  const host = new FakeAdapter();
  const ready = await probeAcpResourceBoundary({ adapter: host });
  assert.equal(ready.ready, true);
  assert.equal(host.calls.length, 2);
  assert.equal(host.spawned, null);
  host.platform = 'win32';
  const unavailable = await probeAcpResourceBoundary({ adapter: host });
  assert.deepEqual(unavailable, {
    ready: false, status: 'unavailable', reason: 'linux_required',
    action: 'Run ACP sessions on Linux with a cgroup-v2 systemd user manager.', provider_started: false,
  });
});

test('launch uses exact limits, clean environment, fixed worker argv, and rejects collisions', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    const launched = await launchAcpResourceBoundary({ prepared, adapter: host });
    assert.deepEqual(host.spawned.options.env, { ...ACP_RESOURCE_ENV, XDG_RUNTIME_DIR: `/run/user/${host.uid}` });
    assert.equal(host.spawned.options.shell, false);
    assert.ok(host.spawned.args.includes(`--property=MemoryMax=${ACP_RESOURCE_LIMITS.memoryMaxBytes}`));
    assert.ok(host.spawned.args.includes('--property=MemorySwapMax=0'));
    assert.ok(host.spawned.args.includes(`--property=TasksMax=${ACP_RESOURCE_LIMITS.tasksMax}`));
    assert.ok(host.spawned.args.includes('--property=KillMode=control-group'));
    assert.ok(host.spawned.args.includes('--expand-environment=no'));
    assert.ok(host.spawned.args.includes(`--max-old-space-size=${ACP_RESOURCE_LIMITS.nodeMaxOldSpaceMiB}`));
    assert.ok(host.spawned.args.includes('--eval'));
    const evalSource = host.spawned.args[host.spawned.args.indexOf('--eval') + 1];
    assert.match(evalSource, /^import\.meta\.url="file:\/\//u);
    const nodeSeparator = host.spawned.args.indexOf('--', host.spawned.args.indexOf('--eval') + 2);
    assert.equal(host.spawned.args[nodeSeparator + 1].endsWith('/worker.mjs'), true);
    assert.equal(host.spawned.args[nodeSeparator + 2], '--fixed-profile=grok-acp');
    const commandSeparator = host.spawned.args.indexOf('--');
    const guard = spawnSync(host.spawned.args[commandSeparator + 1], host.spawned.args.slice(commandSeparator + 2), {
      cwd: '/', env: host.spawned.options.env, shell: false, encoding: 'utf8', timeout: 3_000,
    });
    assert.equal(guard.status, 0, guard.stderr);
    assert.deepEqual(JSON.parse(guard.stdout), [host.spawned.args[nodeSeparator + 1], '--fixed-profile=grok-acp']);
    assert.deepEqual(Object.keys(host.spawned.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_RUNTIME_DIR']);
    assert.equal('SSH_AUTH_SOCK' in host.spawned.options.env, false);
    assert.match(launched.receipt.limits_digest, /^[a-f0-9]{64}$/u);

    const collision = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    host.collision = true;
    await assert.rejects(
      launchAcpResourceBoundary({ prepared: collision.prepared, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'unit_collision',
    );
    await assert.rejects(
      launchAcpResourceBoundary({ prepared, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'prepared_state_consumed',
    );
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('launch waits for a delayed systemd InvocationID instead of rejecting a fresh scope', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    host.invocationDelay = 2;
    const launched = await launchAcpResourceBoundary({ prepared, adapter: host });
    assert.match(launched.receipt.limits_digest, /^[a-f0-9]{64}$/u);
    assert.ok((host.showCounts.get(host.spawned.args.find((arg) => arg.startsWith('--unit='))?.slice(7)) ?? 0) >= 2);
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('launch fails closed when systemd never provides an InvocationID', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    host.invocationDelay = 21;
    await assert.rejects(
      launchAcpResourceBoundary({ prepared, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'unit_verification_failed',
    );
    assert.equal(host.calls.some(({ args }) => args.includes('stop')), false);
    assert.equal(host.calls.some(({ args }) => args.includes('--signal=KILL')), false);
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('spoofed unit is rejected without mutating an unverified generation', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    host.spoof = { MemoryMax: String(ACP_RESOURCE_LIMITS.memoryMaxBytes + 1) };
    await assert.rejects(
      launchAcpResourceBoundary({ prepared, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'spoofed_or_unsafe_unit',
    );
    assert.equal(host.calls.some(({ args }) => args.includes('stop')), false);
    assert.equal(host.calls.some(({ args }) => args.includes('--signal=KILL')), false);
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('escaped descendants require TERM then stop then KILL and an empty cgroup', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    const { handle } = await launchAcpResourceBoundary({ prepared, adapter: host });
    host.stubborn = true;
    const stopped = await stopAcpResourceBoundary({ handle, adapter: host });
    assert.equal(stopped.cgroup_empty, true);
    const signals = host.calls.filter(({ args }) => args[1] === 'kill').map(({ args }) => args.find((arg) => arg.startsWith('--signal=')));
    assert.deepEqual(signals.slice(-2), ['--signal=TERM', '--signal=KILL']);
    assert.equal((await stopAcpResourceBoundary({ handle, adapter: host })).idempotent, true);
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('stale reconciliation requires exact private ownership marker and never accepts a PID', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared, owner } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    const launched = await launchAcpResourceBoundary({ prepared, adapter: host });
    host.spoof = { Description: 'foreign-unit' };
    await assert.rejects(
      reconcileOwnedAcpResourceBoundary({ owner, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'ownership_mismatch',
    );
    await assert.rejects(
      reconcileOwnedAcpResourceBoundary({ owner: { pid: 123 }, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'invalid_owner',
    );
    host.spoof = null;
    assert.deepEqual(await reconcileOwnedAcpResourceBoundary({ owner, adapter: host }), { found: true, stopped: true });
    const restartedProbe = await probeAcpResourceBoundary({ adapter: host });
    const restored = await restoreAcpResourceBoundaryOwner({
      probe: restartedProbe, ownershipId: launched.receipt.ownership_id, ownershipStore: tree.ownershipStore,
    });
    assert.deepEqual(await reconcileOwnedAcpResourceBoundary({ owner: restored, adapter: host }), { found: true, stopped: true });
    const authentic = tree.receipts.get(launched.receipt.ownership_id);
    tree.receipts.set(launched.receipt.ownership_id, {
      ...authentic, invocation_id: 'ffffffffffffffffffffffffffffffff',
    });
    await assert.rejects(
      restoreAcpResourceBoundaryOwner({
        probe: restartedProbe, ownershipId: launched.receipt.ownership_id, ownershipStore: tree.ownershipStore,
      }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'invalid_receipt',
    );
    await assert.rejects(
      restoreAcpResourceBoundaryOwner({ probe: restartedProbe, receipt: authentic }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'unknown_field',
    );
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('concurrent launch is single-use and launcher spawn errors are bounded', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const shared = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    const results = await Promise.allSettled([
      launchAcpResourceBoundary({ prepared: shared.prepared, adapter: host }),
      launchAcpResourceBoundary({ prepared: shared.prepared, adapter: host }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);

    const failingHost = new FakeAdapter();
    const failingProbe = await probeAcpResourceBoundary({ adapter: failingHost });
    const failing = prepareAcpResourceBoundary({ probe: failingProbe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    failingHost.spawnError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    await assert.rejects(
      launchAcpResourceBoundary({ prepared: failing.prepared, adapter: failingHost }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'launch_failed',
    );
    const exitingHost = new FakeAdapter();
    const exitingProbe = await probeAcpResourceBoundary({ adapter: exitingHost });
    const exiting = prepareAcpResourceBoundary({ probe: exitingProbe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    exitingHost.earlyExit = true;
    await assert.rejects(
      launchAcpResourceBoundary({ prepared: exiting.prepared, adapter: exitingHost }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'launcher_exited',
    );
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('cleanup fails closed when the bounded timeout and KILL cannot empty the cgroup', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    const { prepared } = prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore });
    const { handle } = await launchAcpResourceBoundary({ prepared, adapter: host });
    host.stubborn = true;
    host.unkillable = true;
    await assert.rejects(
      stopAcpResourceBoundary({ handle, adapter: host }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'cgroup_not_empty',
    );
    assert.ok(host.calls.some(({ args }) => args.includes('--signal=KILL')));
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('raw commands, environment, unit properties, and excessive runtimes have no input surface', async () => {
  const tree = await fixture();
  try {
    const host = new FakeAdapter();
    const probe = await probeAcpResourceBoundary({ adapter: host });
    assert.throws(
      () => prepareAcpResourceBoundary({
        probe: { ready: true, boundary: 'systemd-user-scope-cgroup-v2' }, worker: tree.worker,
        ownershipStore: tree.ownershipStore,
      }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'boundary_unavailable',
    );
    assert.throws(
      () => prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore, runtimeMs: ACP_RESOURCE_LIMITS.runtimeMaximumMs + 1 }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'invalid_runtime',
    );
    assert.throws(
      () => prepareAcpResourceBoundary({ probe, worker: tree.worker, ownershipStore: tree.ownershipStore, command: ['/bin/sh'], env: process.env, properties: ['Delegate=yes'] }),
      (error) => error instanceof AcpResourceBoundaryError && error.code === 'unknown_field',
    );
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});
