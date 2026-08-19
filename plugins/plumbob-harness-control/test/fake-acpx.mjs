#!/usr/bin/env node

import { stat, readFile } from 'node:fs/promises';
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
process.stdout.write(`${JSON.stringify({
  action: 'flow_run_result',
  status: 'completed',
  outputs: { delegate: 'DSH_FAKE_OK' },
  sessionBindings: { delegate: { acpSessionId: 'dsh-fake-session' } },
})}\n`);
