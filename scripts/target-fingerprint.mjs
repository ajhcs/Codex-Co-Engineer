#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { __testing } from '../plugins/plumbob-harness-control/mcp/control.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: target-fingerprint.mjs TARGET_JSON');
const body = JSON.parse(await readFile(path.resolve(file), 'utf8'));
const targetContext = body.target_context ?? body;
const resolved = await __testing.prepareTarget(targetContext);
process.stdout.write(`${JSON.stringify({
  target_fingerprint: `sha256:${resolved.targetFingerprint}`,
  resolved_workspace: resolved.target.resolved_workspace,
  resolved_cwd: resolved.target.resolved_cwd,
  git_head: resolved.target.observed_head,
}, null, 2)}\n`);

if (import.meta.url !== pathToFileURL(process.argv[1]).href) process.exitCode = 1;

