#!/usr/bin/env node
// Owner-only credential handoff loader for P29. Reads a bounded regular
// file, applies credential env values, unlinks the file, then runs the
// wrapped command as a child so systemd-run argv never carries secrets.
// This process remains the service leader; KillMode=control-group still
// reaches the provider child.

import { spawn } from 'node:child_process';
import path from 'node:path';

import { consumeCredentialHandoff } from './credential-boundary.mjs';

function failUsage() {
  process.stderr.write('Usage: credential-handoff-loader.mjs /absolute/handoff.json -- command [args...]\n');
  process.exit(2);
}

const separator = process.argv.indexOf('--');
if (separator < 3 || process.argv.length <= separator + 1) failUsage();

const handoffPath = process.argv[2];
if (typeof handoffPath !== 'string' || !path.isAbsolute(handoffPath) || path.resolve(handoffPath) !== handoffPath) {
  failUsage();
}

const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) failUsage();

const secrets = await consumeCredentialHandoff(handoffPath);
const env = { ...process.env };
for (const [name, value] of Object.entries(secrets)) {
  if (typeof name === 'string' && typeof value === 'string') env[name] = value;
}
delete env.CODEX_CO_ENGINEER_CREDENTIAL_HANDOFF;

const child = spawn(command, args, {
  env,
  stdio: 'inherit',
  detached: false,
  shell: false,
});

const forward = (signal) => {
  try { child.kill(signal); } catch { /* child may have already exited */ }
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => forward(signal));
}

child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exit(code ?? 1);
});
