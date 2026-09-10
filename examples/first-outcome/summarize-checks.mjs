#!/usr/bin/env node
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { summarizeChecks, formatSummary } = require(
  path.join(root, 'lib', 'summarize-checks.cjs'),
);

function readInput(argv) {
  if (argv.length > 0) {
    return fs.readFileSync(argv[0], 'utf8');
  }
  return fs.readFileSync(0, 'utf8');
}

function main(argv) {
  let raw;
  try {
    raw = readInput(argv);
  } catch (error) {
    process.stderr.write(`failed to read input: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  let checks;
  try {
    checks = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`invalid JSON: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const summary = summarizeChecks(checks);
    process.stdout.write(formatSummary(summary));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
