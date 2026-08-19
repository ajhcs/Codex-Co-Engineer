#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
const defaultConfigDir = path.join(configBase, 'codex-co-engineer');
const configuredConfigFile = env.CODEX_CO_ENGINEER_DSH_ACP_CONFIG?.trim();
if (configuredConfigFile && !path.isAbsolute(configuredConfigFile)) {
  throw new Error('CODEX_CO_ENGINEER_DSH_ACP_CONFIG must be an absolute path.');
}
const configFile = configuredConfigFile ? path.resolve(configuredConfigFile) : path.join(defaultConfigDir, 'dsh-acp.yml');
const configDir = path.dirname(configFile);
const persistenceRoot = path.join(stateBase, 'codex-co-engineer', 'dsh-sessions');
const commands = Object.freeze({
  dsh: env.CODEX_CO_ENGINEER_DSH_COMMAND?.trim() || 'dsh',
  acpx: env.CODEX_CO_ENGINEER_ACPX_COMMAND?.trim() || 'acpx',
  dshAcp: env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND?.trim() || 'dsh-acp-demo',
  worktreeBootstrap: 'worktree-bootstrap',
});

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function executablePath(command) {
  if (!command) return null;
  const candidates = path.isAbsolute(command) || command.includes(path.sep)
    ? [path.resolve(command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

async function validConfig() {
  try {
    const metadata = await stat(configFile);
    const value = await readFile(configFile, 'utf8');
    return metadata.isFile() && (metadata.mode & 0o077) === 0
      && value.includes("name: '@deepseek-ai/dsh-acp-demo'")
      && value.includes('model: muse-spark-1.2-contributor')
      && value.includes('apiKeyEnv: MODEL_API_KEY');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function check() {
  const results = {};
  for (const [name, command, args] of [
    ['dsh', commands.dsh, ['--version']],
    ['acpx', commands.acpx, ['--version']],
    ['worktreeBootstrap', commands.worktreeBootstrap, ['--version']],
  ]) {
    try {
      const { stdout, stderr } = await run(command, args, { cwd: tmpdir(), encoding: 'utf8', timeout: 10_000 });
      results[name] = { ok: true, output: `${stdout}${stderr}`.trim().slice(0, 500) };
    } catch (error) {
      results[name] = { ok: false, output: `${error?.stdout ?? ''}${error?.stderr ?? ''}`.trim().slice(0, 500) };
    }
  }
  const dshAcpPath = await executablePath(commands.dshAcp);
  results.dshAcp = dshAcpPath
    ? { ok: true, output: dshAcpPath }
    : { ok: false, output: `${commands.dshAcp} was not found on PATH.` };
  try {
    const childEnv = { ...env };
    delete childEnv.npm_config_prefix;
    delete childEnv.npm_config_local_prefix;
    const { stdout } = await run('npm', ['root', '--global'], { cwd: tmpdir(), env: childEnv, encoding: 'utf8', timeout: 10_000 });
    const globalRoot = stdout.trim();
    const versions = {};
    for (const [name, relative, expected] of [
      ['dsh', '@deepseek-ai/dsh/package.json', '0.1.0-rc.7'],
      ['dsh-acp-demo', '@deepseek-ai/dsh-acp-demo/package.json', '0.1.0-rc.7'],
      ['dsh-acp', '@deepseek-ai/dsh-acp-demo/node_modules/@deepseek-ai/dsh-acp/package.json', '0.1.0-rc.7'],
      ['dsh-agent-spine-demo', '@deepseek-ai/dsh-acp-demo/node_modules/@deepseek-ai/dsh-agent-spine-demo/package.json', '0.1.0-rc.7'],
      ['cursor-sdk', '@cursor/sdk/package.json', '1.0.28'],
      ['acpx', 'acpx/package.json', '0.13.0'],
    ]) {
      versions[name] = JSON.parse(await readFile(path.join(globalRoot, relative), 'utf8')).version;
      if (versions[name] !== expected) throw new Error(`${name} expected ${expected}, found ${versions[name]}`);
    }
    results.packages = { ok: true, versions };
  } catch (error) {
    results.packages = { ok: false, output: error?.message ?? String(error) };
  }
  results.config = { ok: await validConfig(), path: configFile };
  try {
    const metadata = await stat(persistenceRoot);
    results.persistence = { ok: metadata.isDirectory() && (metadata.mode & 0o077) === 0, path: persistenceRoot };
  } catch (error) {
    results.persistence = { ok: false, path: persistenceRoot, output: error?.code ?? 'unavailable' };
  }
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
  if (!configuredConfigFile) await chmod(configDir, 0o700);
  await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
  await chmod(persistenceRoot, 0o700);
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
  } else if (!await validConfig()) {
    throw new Error(`Existing DSH ACP config is incompatible or not owner-only: ${configFile}`);
  }
  process.stdout.write(`Installed Co-Engineer agent dependencies (ACPX, Cursor SDK, and the cohesive DSH rc.7 ACP composition).\nDSH config: ${configFile}\n`);
  if (!await check()) process.exitCode = 1;
}

if (process.argv.includes('--check')) {
  if (!await check()) process.exitCode = 1;
} else {
  await install();
}
