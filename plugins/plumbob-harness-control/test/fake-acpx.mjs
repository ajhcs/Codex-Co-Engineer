#!/usr/bin/env node

import { stat, readFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const inputIndex = argv.indexOf('--input-file');
if (inputIndex < 0 || !argv.includes('--approve-all') || !argv.includes('--json-strict') || !argv.includes('flow')) {
  process.stderr.write('missing required ACPX arguments\n');
  process.exit(2);
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
process.stdout.write(`${JSON.stringify({
  action: 'flow_run_result',
  status: 'completed',
  outputs: { delegate: 'DSH_FAKE_OK' },
  sessionBindings: { delegate: { acpSessionId: 'dsh-fake-session' } },
})}\n`);
