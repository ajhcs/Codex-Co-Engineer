import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workerPath = join(root, 'plugins/plumbob-harness-control/mcp/acpx-worker.mjs');
const fakeAgentPath = join(root, 'plugins/plumbob-harness-control/test/acpx-fake-agent.mjs');
const modeMask = 0o7777;

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function forceKill(child) {
  if (child.exitCode !== null) return;
  const exited = waitForExit(child, 2000);
  child.kill('SIGKILL');
  await exited;
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for worker exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

class WorkerHarness {
  #child;
  #lines = [];
  #waiters = [];
  #stderr = '';

  constructor(child) {
    this.#child = child;
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity, terminal: false });
    output.on('line', (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        value = { type: 'malformed-worker-output', raw: line };
      }
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(value);
      else this.#lines.push(value);
    });
    child.stderr.on('data', (chunk) => {
      this.#stderr += chunk.toString();
    });
    let exitDescription = 'unknown';
    child.once('exit', (code, signal) => {
      exitDescription = code ?? signal;
    });
    output.once('close', () => {
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(new Error(`worker exited (${exitDescription}): ${this.#stderr}`));
      }
    });
  }

  send(request) {
    this.#child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  sendRaw(line) {
    this.#child.stdin.write(`${line}\n`);
  }

  async next(timeoutMs = 5000) {
    if (this.#lines.length > 0) return this.#lines.shift();
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error(`timed out waiting for worker output: ${this.#stderr}`));
      }, timeoutMs);
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  async until(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    const seen = [];
    while (Date.now() < deadline) {
      const value = await this.next(Math.max(1, deadline - Date.now()));
      seen.push(value);
      if (predicate(value)) return { value, seen };
    }
    throw new Error(`timed out waiting for matching output: ${JSON.stringify(seen)}`);
  }

  async shutdown() {
    if (this.#child.exitCode !== null) return;
    const exited = waitForExit(this.#child);
    this.send({ id: 'shutdown', op: 'shutdown' });
    await this.until((value) => value.id === 'shutdown' && value.type === 'result');
    if (this.#child.exitCode !== null) return;
    await exited.catch((error) => {
      throw new Error(`worker did not exit: ${this.#stderr}`, { cause: error });
    });
  }
}

function workerEnv(ambientHome) {
  return {
    PATH: process.env.PATH,
    HOME: ambientHome,
    AMBIENT_PROVIDER_TOKEN: 'must-not-reach-fake-agent',
    ACPX_CONFIG: join(ambientHome, 'hostile-config.json'),
    XAI_API_KEY: 'must-not-reach-fake-agent',
    npm_package_name: 'ambient-package-name',
    npm_package_version: 'ambient-package-version',
  };
}

function workerArgv(fixture, overrides = {}) {
  return [
    workerPath,
    '--cwd', overrides.cwd ?? fixture.cwd,
    '--runtime-root', overrides.runtimeRoot ?? fixture.runtimeRoot,
    '--fixture-mode', overrides.fixtureMode ?? fixture.fixtureMode ?? 'normal',
    '--job-id', overrides.jobId ?? fixture.jobId,
    '--target-profile-digest', overrides.digest ?? fixture.digest,
  ];
}

async function createHarness(name = 'job-flow', { fixtureMode = 'normal' } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'acpx-worker-test-'));
  const cwd = join(base, 'target');
  const ambientHome = join(base, 'ambient-home');
  const jobId = name;
  const digest = createHash('sha256').update(`${cwd}:${name}:read-only`).digest('hex');
  const runtimeRoot = join(base, `acpx-${jobId}`);
  await mkdir(cwd, { mode: 0o750 });
  await mkdir(ambientHome, { mode: 0o700 });
  await mkdir(join(ambientHome, '.acpx'), { mode: 0o700 });
  await mkdir(join(cwd, '.acpx'), { mode: 0o750 });
  await writeFile(join(ambientHome, '.acpx/config.json'), JSON.stringify({
    defaultPermissions: 'approve-all',
    agent: 'provider-must-not-run',
  }));
  await writeFile(join(cwd, '.acpx/config.json'), JSON.stringify({
    defaultPermissions: 'approve-all',
    agent: 'provider-must-not-run',
  }));
  await writeFile(join(cwd, '.acpxrc'), JSON.stringify({
    defaultPermissions: 'approve-all',
    command: 'provider-must-not-run',
  }));
  const child = spawn(process.execPath, workerArgv({ cwd, runtimeRoot, jobId, digest, fixtureMode }), {
    cwd: root,
    env: workerEnv(ambientHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const harness = new WorkerHarness(child);
  const ready = await harness.until((value) => value.type === 'ready');
  return {
    harness,
    child,
    ready: ready.value,
    base,
    cwd,
    ambientHome,
    runtimeRoot,
    homeDir: join(runtimeRoot, 'home'),
    stateDir: join(runtimeRoot, 'state'),
    jobId,
    digest,
    fixtureMode,
  };
}

async function eventually(check, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  return false;
}

async function assertManagedTree(path) {
  const stat = await lstat(path);
  assert.equal(stat.isSymbolicLink(), false, path);
  assert.equal(stat.uid, process.getuid(), path);
  if (stat.isDirectory()) {
    assert.equal(stat.mode & modeMask, 0o700, path);
    for (const entry of await readdir(path)) await assertManagedTree(join(path, entry));
    return;
  }
  assert.equal(stat.isFile(), true, path);
  assert.equal(stat.mode & modeMask, 0o600, path);
  assert.equal(stat.nlink, 1, path);
}

async function collectFileText(path) {
  const stat = await lstat(path);
  if (stat.isFile()) return readFile(path, 'utf8');
  const values = [];
  for (const entry of await readdir(path)) values.push(await collectFileText(join(path, entry)));
  return values.join('\n');
}

async function assertNoSensitivePersistentState(fixture, sensitiveValues) {
  const persisted = await collectFileText(fixture.runtimeRoot);
  for (const value of sensitiveValues) {
    assert.equal(persisted.includes(value), false, `runtime state persisted sensitive value: ${value.slice(0, 32)}`);
  }
  assert.deepEqual(await readdir(fixture.stateDir), [], 'disabled worker must not create persistent ACPX sessions');
}

async function expectStartupRejection(argv, env, pattern) {
  await assert.rejects(
    execFile(process.execPath, argv, { cwd: root, env, timeout: 3000 }),
    (error) => pattern.test(error.stderr ?? ''),
  );
}

test('importing the worker exposes no in-process API or process-global mutation', async () => {
  const moduleUrl = pathToFileURL(workerPath).href;
  const sentinel = 'unchanged-sentinel';
  const { stdout } = await execFile(process.execPath, [
    '--input-type=module',
    '-e',
    `const before={cwd:process.cwd(),home:process.env.HOME,sentinel:process.env.ACPX_IMPORT_SENTINEL};const module=await import(${JSON.stringify(moduleUrl)});process.stdout.write(JSON.stringify({before,after:{cwd:process.cwd(),home:process.env.HOME,sentinel:process.env.ACPX_IMPORT_SENTINEL},exports:Object.keys(module)}));`,
  ], {
    cwd: root,
    env: { ...process.env, ACPX_IMPORT_SENTINEL: sentinel },
  });
  const observed = JSON.parse(stdout);
  assert.deepEqual(observed.after, observed.before);
  assert.equal(observed.after.sentinel, sentinel);
  assert.deepEqual(observed.exports, []);
});

test('worker pins the one repository fixture and launches its verified source bytes, never its pathname', async (t) => {
  const source = await readFile(workerPath, 'utf8');
  const pinnedDigest = source.match(/const PINNED_AGENT_SHA256 = '([a-f0-9]{64})';/u)?.[1];
  assert.ok(pinnedDigest, 'worker must contain one explicit fixture digest');
  assert.equal(
    createHash('sha256').update(await readFile(fakeAgentPath)).digest('hex'),
    pinnedDigest,
  );
  assert.equal(await realpath(fakeAgentPath), fakeAgentPath);
  assert.equal(await realpath(dirname(fakeAgentPath)), dirname(fakeAgentPath));
  const agentStat = await lstat(fakeAgentPath);
  assert.equal(agentStat.uid, process.getuid());
  assert.equal(agentStat.nlink, 1);
  assert.equal((agentStat.mode & 0o022), 0, 'fixture must not be group/world writable');
  assert.equal((agentStat.mode & 0o111), 0, 'fixture must not be executable');
  const runtimeConstruction = source.slice(
    source.indexOf('async function createRuntime'),
    source.indexOf('class AcpxCliWorker'),
  );
  assert.match(runtimeConstruction, /'--eval',\s*paths\.agent\.sourceText,/u);
  assert.doesNotMatch(runtimeConstruction, /paths\.agent\.path/u);

  const base = await mkdtemp(join(tmpdir(), 'acpx-worker-agent-pin-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, 'target');
  const ambientHome = join(base, 'ambient-home');
  const arbitrary = join(base, 'acpx-fake-agent.mjs');
  await mkdir(cwd, { mode: 0o750 });
  await mkdir(ambientHome, { mode: 0o700 });
  await writeFile(arbitrary, 'process.exit(0);\n', { mode: 0o600 });
  const fixture = {
    cwd,
    runtimeRoot: join(base, 'acpx-job-pin'),
    jobId: 'job-pin',
    digest: 'a'.repeat(64),
  };
  await expectStartupRejection(
    [...workerArgv(fixture), '--agent-script', arbitrary],
    workerEnv(ambientHome),
    /Usage:|unsupported|agent-script/iu,
  );
});

test('one-shot worker ignores ambient config, denies permission, binds state, and preserves target mode', async (t) => {
  const fixture = await createHarness('job-flow');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });
  assert.equal(fixture.ready.disabled, true);
  assert.equal(fixture.ready.activation_ready, false);
  assert.deepEqual(fixture.ready.prerequisites, [
    'verified-target-context-and-fingerprint',
    'outer-bubblewrap-target-policy',
    'outer-clean-launcher-environment',
    'outer-memory-and-process-limits',
    'outer-process-group-or-cgroup-reaping',
    'outer-bounded-acp-transport',
  ]);

  const prompt = 'permission please PERSISTENCE-SUCCESS-SECRET';
  fixture.harness.send({ id: 'deny', op: 'prompt', prompt });
  const denied = await fixture.harness.until((value) => value.id === 'deny' && value.type === 'result');
  assert.equal(denied.value.result.status, 'completed');
  assert.ok(denied.seen.some((value) => value.event?.text === 'permission-selected-reject'));
  assert.equal((await lstat(fixture.cwd)).mode & modeMask, 0o750, 'worker must not chmod cwd');

  const observed = JSON.parse(await readFile(join(fixture.cwd, '.acpx-fake-observed.json'), 'utf8'));
  assert.deepEqual(observed.argv, ['acpx-verified-fake-agent', '--mode', 'normal']);
  assert.equal(observed.argv.includes(fakeAgentPath), false, 'mutable fixture path must never reach spawn argv');
  assert.equal(observed.cwd, fixture.cwd);
  assert.equal(observed.env.HOME, fixture.homeDir);
  assert.equal(observed.env.USERPROFILE, fixture.homeDir);
  assert.equal(observed.env.npm_package_name, 'acpx');
  assert.equal(observed.env.npm_package_version, '0.13.0');
  assert.deepEqual(Object.keys(observed.env).sort(), [
    'HOME',
    'NODE_NO_WARNINGS',
    'USERPROFILE',
    'npm_package_name',
    'npm_package_version',
  ]);
  assert.ok(await readFile(join(fixture.cwd, '.acpxrc'), 'utf8'));
  assert.ok(await readFile(join(fixture.cwd, '.acpx/config.json'), 'utf8'));
  assert.ok(await readFile(join(fixture.cwd, '.acpx-fake-close.json'), 'utf8'));

  await assertManagedTree(fixture.runtimeRoot);
  await assertNoSensitivePersistentState(fixture, [
    prompt,
    await readFile(fakeAgentPath, 'utf8'),
    'must-not-reach-fake-agent',
  ]);

  fixture.harness.send({ id: 'second', op: 'prompt', prompt: 'must not reuse the session' });
  const second = await fixture.harness.until((value) => value.id === 'second' && value.type === 'error');
  assert.equal(second.value.error.code, 'single_turn_only');

  fixture.harness.send({ id: 'status', op: 'status' });
  const status = await fixture.harness.until((value) => value.id === 'status' && value.type === 'result');
  assert.equal(status.value.result.activation_ready, false);
  assert.ok(status.value.result.prerequisites.includes('outer-bubblewrap-target-policy'));
});

test('cancellation is bounded and reaps a cooperative fake descendant', async (t) => {
  const fixture = await createHarness('job-cancel');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });
  const prompt = 'slow cancellation PERSISTENCE-CANCEL-SECRET';
  fixture.harness.send({ id: 'slow', op: 'prompt', prompt });
  await fixture.harness.until((value) => value.id === 'slow' && value.type === 'event');
  const pidPath = join(fixture.cwd, '.acpx-fake-descendant.pid');
  const descendantPid = await eventually(async () => {
    try {
      return Number.parseInt(await readFile(pidPath, 'utf8'), 10);
    } catch {
      return false;
    }
  });
  assert.ok(Number.isInteger(descendantPid));

  fixture.harness.send({ id: 'cancel', op: 'cancel', reason: 'test cancellation' });
  const cancel = await fixture.harness.until((value) => value.id === 'cancel' && value.type === 'result');
  assert.equal(cancel.value.result.cancelled, true);
  const promptResult = await fixture.harness.until((value) => value.id === 'slow' && value.type === 'result');
  assert.equal(promptResult.value.result.status, 'cancelled');
  const gone = await eventually(async () => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  });
  assert.equal(gone, true);
  await assertManagedTree(fixture.runtimeRoot);
  await assertNoSensitivePersistentState(fixture, [prompt, await readFile(fakeAgentPath, 'utf8')]);
});

test('provider failures cannot render source, argv, or prompt into output or persistent state', async (t) => {
  const fixture = await createHarness('job-provider-failure');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });
  const prompt = 'provider-failure PERSISTENCE-PROVIDER-SECRET';
  const source = await readFile(fakeAgentPath, 'utf8');
  fixture.harness.send({ id: 'provider-failure', op: 'prompt', prompt });
  const terminal = await fixture.harness.until(
    (value) => value.id === 'provider-failure' && (value.type === 'error' || value.type === 'result'),
  );
  const renderedOutput = JSON.stringify(terminal.seen);
  assert.equal(renderedOutput.includes(prompt), false);
  assert.equal(renderedOutput.includes(source), false);
  assert.equal(renderedOutput.includes('--eval'), false);
  if (terminal.value.type === 'result') {
    assert.equal(terminal.value.result.status, 'failed');
    assert.equal(terminal.value.result.error.message, 'ACP runtime turn failed.');
  } else {
    assert.equal(terminal.value.error.message, 'ACP worker operation failed.');
  }
  await assertNoSensitivePersistentState(fixture, [prompt, source]);
});

test('malformed input and UTF-8 byte bounds fail closed before one valid turn', async (t) => {
  const fixture = await createHarness('job-bounds');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });

  fixture.harness.send({ id: 'privilege-flag', op: 'prompt', prompt: 'permission', allowPermission: true });
  const privilegeFlag = await fixture.harness.until((value) => value.id === 'privilege-flag' && value.type === 'error');
  assert.equal(privilegeFlag.value.error.code, 'invalid_request');

  fixture.harness.send({ id: 'too-big', op: 'prompt', prompt: '😀'.repeat(1100) });
  const tooBig = await fixture.harness.until((value) => value.id === 'too-big' && value.type === 'error');
  assert.equal(tooBig.value.error.code, 'prompt_too_large');

  fixture.harness.send({ id: 'unknown', op: 'not-a-worker-op' });
  const unknown = await fixture.harness.until((value) => value.id === 'unknown' && value.type === 'error');
  assert.equal(unknown.value.error.code, 'unsupported_op');

  fixture.harness.sendRaw('{"id":"broken"');
  const broken = await fixture.harness.until((value) => value.id === null && value.type === 'error');
  assert.equal(broken.value.error.code, 'invalid_json');

  fixture.harness.sendRaw('x'.repeat(16 * 1024 + 1));
  const oversizedLine = await fixture.harness.until((value) => value.id === null && value.type === 'error');
  assert.equal(oversizedLine.value.error.code, 'input_too_large');

  fixture.harness.send({ id: 'large', op: 'prompt', prompt: 'large output' });
  const large = await fixture.harness.until((value) => value.id === 'large' && value.type === 'result');
  const largeEvent = large.seen.find((value) => value.id === 'large' && value.type === 'event');
  assert.ok(largeEvent);
  assert.ok(Buffer.byteLength(largeEvent.event.text, 'utf8') <= 512);
  assert.match(largeEvent.event.text, /…$/u);
  assert.equal(large.value.result.status, 'completed');
});

test('event overflow preserves a bounded terminal error frame', async (t) => {
  const fixture = await createHarness('job-overflow');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });
  fixture.harness.send({ id: 'overflow', op: 'prompt', prompt: 'output-overflow large' });
  const terminal = await fixture.harness.until(
    (value) => value.id === 'overflow' && (value.type === 'error' || value.type === 'result'),
    7000,
  );
  assert.equal(terminal.value.type, 'error');
  assert.equal(terminal.value.error.code, 'output_too_large');
  assert.ok(Buffer.byteLength(JSON.stringify(terminal.value), 'utf8') <= 1024);
  const eventBytes = terminal.seen
    .filter((value) => value.id === 'overflow' && value.type === 'event')
    .reduce((total, value) => total + Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8'), 0);
  assert.ok(eventBytes <= 16 * 1024 - 1024);
});

test('a hostile non-responsive ACP turn reaches a bounded terminal failure', async (t) => {
  const fixture = await createHarness('job-timeout');
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    await rm(fixture.base, { recursive: true, force: true });
  });
  const started = Date.now();
  const prompt = 'hostile-timeout PERSISTENCE-TIMEOUT-SECRET';
  fixture.harness.send({ id: 'timeout', op: 'prompt', prompt });
  const terminal = await fixture.harness.until(
    (value) => value.id === 'timeout' && (value.type === 'error' || value.type === 'result'),
    7000,
  );
  assert.ok(Date.now() - started < 7000);
  if (terminal.value.type === 'result') assert.equal(terminal.value.result.status, 'failed', JSON.stringify(terminal.value));
  else assert.match(terminal.value.error.code, /timeout|ACP_/iu);
  await assertNoSensitivePersistentState(fixture, [prompt, await readFile(fakeAgentPath, 'utf8')]);
});

for (const [fixtureMode, label] of [
  ['silent-initialize', 'initialization'],
  ['silent-session-create', 'session creation'],
]) {
  test(`one absolute deadline bounds a fixture silent during ACP ${label}`, async (t) => {
    const fixture = await createHarness(`job-${fixtureMode}`, { fixtureMode });
    t.after(async () => {
      await forceKill(fixture.child);
      await rm(fixture.base, { recursive: true, force: true });
    });
    const started = Date.now();
    fixture.harness.send({ id: 'startup-timeout', op: 'prompt', prompt: 'must be bounded before prompt' });
    const terminal = await fixture.harness.until(
      (value) => value.id === 'startup-timeout' && value.type === 'error',
      6000,
    );
    assert.equal(terminal.value.error.code, 'worker_timeout');
    assert.ok(Date.now() - started < 6000, 'absolute deadline must include startup/session creation');
    assert.ok(terminal.seen.some((value) => value.id === 'startup-timeout' && value.type === 'accepted'));
  });
}

test('hostile unterminated ACP frame demonstrates the required outer transport/memory boundary', async (t) => {
  const fixture = await createHarness('job-raw-frame', { fixtureMode: 'raw-partial-frame' });
  t.after(async () => {
    await forceKill(fixture.child);
    await rm(fixture.base, { recursive: true, force: true });
  });
  assert.ok(fixture.ready.prerequisites.includes('outer-bounded-acp-transport'));
  assert.ok(fixture.ready.prerequisites.includes('outer-memory-and-process-limits'));
  const started = Date.now();
  fixture.harness.send({ id: 'raw-frame', op: 'prompt', prompt: 'exercise raw ACP transport' });
  const terminal = await fixture.harness.until(
    (value) => value.id === 'raw-frame' && value.type === 'error',
    6000,
  );
  assert.equal(terminal.value.error.code, 'worker_timeout');
  assert.ok(Date.now() - started < 6000);
});

test('startup rejects symlink aliases, target overlap, and unsafe broad roots', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'acpx-worker-path-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, 'target');
  const alias = join(base, 'target-alias');
  const ambientHome = join(base, 'ambient-home');
  await mkdir(cwd, { mode: 0o750 });
  await mkdir(ambientHome, { mode: 0o700 });
  await symlink(cwd, alias, 'dir');
  const fixture = {
    cwd,
    runtimeRoot: join(base, 'acpx-job-path'),
    jobId: 'job-path',
    digest: 'a'.repeat(64),
  };
  const env = workerEnv(ambientHome);

  await expectStartupRejection(
    workerArgv(fixture, { cwd: alias }),
    env,
    /symbolic link|canonical|alias/iu,
  );
  await expectStartupRejection(
    workerArgv(fixture, { runtimeRoot: join(cwd, 'acpx-job-path') }),
    env,
    /must not overlap/iu,
  );
  await expectStartupRejection(
    workerArgv(fixture, { cwd: '/tmp' }),
    env,
    /unsafe broad root/iu,
  );

  const preexisting = join(base, 'acpx-job-existing');
  await mkdir(preexisting, { mode: 0o700 });
  await expectStartupRejection(
    workerArgv(fixture, { runtimeRoot: preexisting, jobId: 'job-existing' }),
    env,
    /must not already exist/iu,
  );
});

test('SIGTERM reports managed-tree cleanup failure and exits nonzero', async (t) => {
  const fixture = await createHarness('job-signal-cleanup');
  t.after(async () => {
    await forceKill(fixture.child);
    await rm(fixture.base, { recursive: true, force: true });
  });
  await writeFile(join(fixture.homeDir, 'unsafe-mode'), 'unsafe\n', { mode: 0o644 });
  const exit = waitForExit(fixture.child);
  assert.equal(fixture.child.kill('SIGTERM'), true);
  const terminal = await fixture.harness.until(
    (value) => value.id === 'signal' && value.type === 'error',
  );
  assert.equal(terminal.value.error.message, 'ACP worker operation failed.');
  const exited = await exit;
  assert.notEqual(exited.code, 0);
  assert.equal(
    terminal.seen.some((value) => value.id === 'signal' && value.type === 'result'),
    false,
    'SIGTERM must not emit a success result after cleanup failure',
  );
});

test('stdin EOF reports managed-tree cleanup failure and exits nonzero', async (t) => {
  const fixture = await createHarness('job-eof-cleanup');
  t.after(async () => {
    await forceKill(fixture.child);
    await rm(fixture.base, { recursive: true, force: true });
  });
  await writeFile(join(fixture.stateDir, 'unsafe-mode'), 'unsafe\n', { mode: 0o644 });
  const exit = waitForExit(fixture.child);
  fixture.child.stdin.end();
  const terminal = await fixture.harness.until(
    (value) => value.id === 'eof' && value.type === 'error',
  );
  assert.equal(terminal.value.error.message, 'ACP worker operation failed.');
  const exited = await exit;
  assert.notEqual(exited.code, 0);
});

test('non-cooperative descendants demonstrate the required outer process-group boundary', async (t) => {
  const fixture = await createHarness('job-hostile-child');
  let descendantPid;
  t.after(async () => {
    await fixture.harness.shutdown().catch(() => fixture.child.kill('SIGKILL'));
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await rm(fixture.base, { recursive: true, force: true });
  });

  fixture.harness.send({ id: 'hostile', op: 'prompt', prompt: 'hostile-descendant slow' });
  await fixture.harness.until((value) => value.id === 'hostile' && value.type === 'event');
  descendantPid = await eventually(async () => {
    try {
      return Number.parseInt(await readFile(join(fixture.cwd, '.acpx-fake-descendant.pid'), 'utf8'), 10);
    } catch {
      return false;
    }
  });
  assert.ok(Number.isInteger(descendantPid));
  fixture.harness.send({ id: 'cancel-hostile', op: 'cancel' });
  await fixture.harness.until((value) => value.id === 'cancel-hostile' && value.type === 'result');
  await fixture.harness.until((value) => value.id === 'hostile' && value.type === 'result');
  await fixture.harness.shutdown();

  assert.doesNotThrow(() => process.kill(descendantPid, 0), 'inner worker cannot reap a detached hostile descendant');
  process.kill(descendantPid, 'SIGKILL');
  const gone = await eventually(async () => {
    try {
      process.kill(descendantPid, 0);
      return false;
    } catch (error) {
      return error?.code === 'ESRCH';
    }
  });
  assert.equal(gone, true);
  descendantPid = undefined;
});
