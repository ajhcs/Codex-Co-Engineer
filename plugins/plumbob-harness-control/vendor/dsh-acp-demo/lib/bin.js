#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot';

const NAME = 'dsh-acp-demo';
installFailLoud(NAME);
const snapshotMode = process.env.DSH_SNAPSHOT;
if (snapshotMode !== 'replay') loadEnv(NAME);
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
});
const context = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode));
if (snapshotMode !== undefined) process.stdin.on('end', () => {
  context.fiber.dispose().then(() => process.exit(0));
});
