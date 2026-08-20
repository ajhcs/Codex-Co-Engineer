#!/usr/bin/env node

import { mkdir, stat, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const inputIndex = argv.indexOf('--input-file');
const agentIndex = argv.indexOf('--agent');
const cwdIndex = argv.indexOf('--cwd');
const timeoutIndex = argv.indexOf('--timeout');
const flowIndex = argv.indexOf('flow');
if (
  inputIndex < 0
  || agentIndex < 0
  || cwdIndex < 0
  || timeoutIndex < 0
  || flowIndex < 0
  || argv[flowIndex + 1] !== 'run'
  || !argv.includes('--approve-all')
  || !argv.includes('--json-strict')
) {
  process.stderr.write('missing required ACPX arguments\n');
  process.exit(2);
}
const agent = argv[agentIndex + 1];
const cwd = argv[cwdIndex + 1];
const timeout = Number(argv[timeoutIndex + 1]);
if (
  typeof agent !== 'string'
  || !agent.includes("'--mode'")
  || typeof cwd !== 'string'
  || !path.isAbsolute(cwd)
  || !Number.isInteger(timeout)
  || timeout < 1
) {
  process.stderr.write('invalid deterministic ACPX invocation\n');
  process.exit(5);
}
const input = argv[inputIndex + 1];
const metadata = await stat(input);
if ((metadata.mode & 0o077) !== 0) {
  process.stderr.write('flow input is not owner-only\n');
  process.exit(3);
}
const value = JSON.parse(await readFile(input, 'utf8'));
if (typeof value.prompt !== 'string' || value.prompt.length === 0) {
  process.stderr.write('missing prompt\n');
  process.exit(4);
}
if (argv.some((entry) => entry === value.prompt)) {
  process.stderr.write('prompt must not be passed in ACPX argv\n');
  process.exit(6);
}

const fakeMode = process.env.FAKE_ACPX_MODE ?? 'success';
const home = process.env.HOME;
if (typeof home !== 'string' || !path.isAbsolute(home)) {
  process.stderr.write('task-scoped HOME is required\n');
  process.exit(7);
}
const homeMetadata = await stat(home);
if (!homeMetadata.isDirectory() || (homeMetadata.mode & 0o077) !== 0) {
  process.stderr.write('task-scoped HOME is not owner-only\n');
  process.exit(8);
}
await mkdir(path.join(home, '.acpx', 'flows', 'runs', 'fake-run'), { recursive: true, mode: 0o700 });
await mkdir(path.join(home, '.acpx', 'sessions'), { recursive: true, mode: 0o700 });
await writeFile(path.join(home, '.acpx', 'flows', 'runs', 'fake-run', 'trace.ndjson'), 'private fake flow trace\n', { mode: 0o600 });
await writeFile(path.join(home, '.acpx', 'sessions', 'session.json'), 'private fake session\n', { mode: 0o600 });
if (process.env.FAKE_ACPX_ARTIFACT_MARKER) {
  await writeFile(process.env.FAKE_ACPX_ARTIFACT_MARKER, 'created\n', { mode: 0o600 });
}

if (fakeMode === 'fail-after-spawn') {
  process.stderr.write('fake ACPX failed after spawn\n');
  process.exit(17);
}

if (fakeMode === 'timeout-tree') {
  const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  descendant.unref();
  if (process.env.FAKE_ACPX_DESCENDANT_PID_FILE) {
    await writeFile(process.env.FAKE_ACPX_DESCENDANT_PID_FILE, `${descendant.pid}\n`, { mode: 0o600 });
  }
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

const output = fakeMode === 'terminal-verdict'
  ? `${'x'.repeat(5000)}\nVERDICT: DSH PASS`
  : fakeMode === 'terminal-object'
    ? { progress: 'x'.repeat(5000), nested: { final: `${'y'.repeat(5000)}\nVERDICT: DSH OBJECT PASS` } }
    : 'DSH_FAKE_OK';
process.stdout.write(`${JSON.stringify({
  action: 'flow_run_result',
  status: 'completed',
  outputs: { delegate: output },
  sessionBindings: { delegate: { acpSessionId: 'dsh-fake-session' } },
})}\n`);
