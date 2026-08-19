#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(PLUGIN, 'vendor', 'dsh-acp-demo');
const env = process.env;
const configBase = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.config');
const stateBase = env.XDG_STATE_HOME ? path.resolve(env.XDG_STATE_HOME) : path.join(env.HOME ? path.resolve(env.HOME) : homedir(), '.local', 'state');
const configDir = path.join(configBase, 'codex-co-engineer');
const configFile = path.join(configDir, 'dsh-acp.yml');
const persistenceRoot = path.join(stateBase, 'codex-co-engineer', 'dsh-sessions');

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function check() {
  const results = {};
  for (const [name, argv] of Object.entries({
    dsh: ['dsh', ['--version']],
    acp: ['which', ['dsh-acp-demo']],
    cursorSdk: ['npm', ['list', '--global', '--depth=0', '@cursor/sdk@1.0.28']],
  })) {
    try {
      const { stdout, stderr } = await run(argv[0], argv[1], { encoding: 'utf8', timeout: 10_000 });
      results[name] = { ok: true, output: `${stdout}${stderr}`.trim().slice(0, 500) };
    } catch (error) {
      results[name] = { ok: false, output: `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim().slice(0, 500) };
    }
  }
  results.config = { ok: await exists(configFile), path: configFile };
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  return Object.values(results).every((result) => result.ok);
}

async function install() {
  const staging = await mkdtemp(path.join(tmpdir(), 'co-engineer-dsh-acp-'));
  try {
    const { stdout } = await run('npm', ['pack', VENDOR, '--pack-destination', staging], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const archive = path.join(staging, stdout.trim().split(/\r?\n/u).at(-1));
    await run('npm', [
      'install',
      '--global',
      '--no-audit',
      '--no-fund',
      'acpx@0.13.0',
      '@cursor/sdk@1.0.28',
      '@deepseek-ai/dsh@0.1.0-rc.7',
      '@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.7',
      '@deepseek-ai/dsh-subprocess-local@0.1.0-rc.7',
      '@deepseek-ai/dsh-bash-local@0.1.0-rc.7',
      archive,
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  if (!await exists(configFile)) {
    const yaml = [
      "- id: llm-pi-ai",
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      meta:',
      '        displayName: Meta Model API',
      '        apiKeyEnv: MODEL_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://api.meta.ai/v1',
      '        models:',
      '          - id: muse-spark-1.2-contributor',
      '            name: Muse Spark 1.2 Contributor',
      '            contextWindow: 1048576',
      '            maxTokens: 131072',
      '            input: [text, image]',
      '',
      '- id: subprocess',
      "  name: '@deepseek-ai/dsh-subprocess-local'",
      '',
      '- id: bash',
      "  name: '@deepseek-ai/dsh-bash-local'",
      '',
      '- id: acp-agent',
      "  name: '@deepseek-ai/dsh-acp-demo'",
      '  config:',
      '    provider: meta',
      '    model: muse-spark-1.2-contributor',
      `    persistenceRoot: ${JSON.stringify(persistenceRoot)}`,
      '    persistenceCompression: none',
      "    persona: 'You are a trusted autonomous coding agent. Follow the client request, use available tools, run tests, and commit coherent implementation work.'",
      '    workspaceContext: false',
      '',
    ].join('\n');
    await writeFile(configFile, yaml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(`Installed the cohesive DSH rc.7 ACP composition.\nConfig: ${configFile}\n`);
  if (!await check()) process.exitCode = 1;
}

if (process.argv.includes('--check')) {
  if (!await check()) process.exitCode = 1;
} else {
  await install();
}
