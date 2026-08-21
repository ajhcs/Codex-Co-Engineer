#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const configuredOxConfigFile = env.CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG?.trim();
if (configuredOxConfigFile && !path.isAbsolute(configuredOxConfigFile)) {
  throw new Error('CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG must be an absolute path.');
}
const configuredGlobalRoot = env.CODEX_CO_ENGINEER_NPM_GLOBAL_ROOT?.trim();
if (configuredGlobalRoot && !path.isAbsolute(configuredGlobalRoot)) {
  throw new Error('CODEX_CO_ENGINEER_NPM_GLOBAL_ROOT must be an absolute path.');
}
const configuredOutputFile = env.CODEX_CO_ENGINEER_SETUP_OUTPUT_FILE?.trim();
if (configuredOutputFile && !path.isAbsolute(configuredOutputFile)) {
  throw new Error('CODEX_CO_ENGINEER_SETUP_OUTPUT_FILE must be an absolute path.');
}
let outputFileInitialized = false;
const configFile = configuredConfigFile ? path.resolve(configuredConfigFile) : path.join(defaultConfigDir, 'dsh-acp.yml');
const oxConfigFile = configuredOxConfigFile
  ? path.resolve(configuredOxConfigFile)
  : path.join(defaultConfigDir, 'dsh-acp-ox-alpha.yml');
const configDirs = [...new Set([path.dirname(configFile), path.dirname(oxConfigFile)])];
const persistenceRoot = path.join(stateBase, 'codex-co-engineer', 'dsh-sessions');
const commands = Object.freeze({
  dsh: env.CODEX_CO_ENGINEER_DSH_COMMAND?.trim() || 'dsh',
  acpx: env.CODEX_CO_ENGINEER_ACPX_COMMAND?.trim() || 'acpx',
  dshAcp: env.CODEX_CO_ENGINEER_DSH_ACP_COMMAND?.trim() || 'dsh-acp-demo',
  worktreeBootstrap: 'worktree-bootstrap',
});
const DSH_RC7 = '0.1.0-rc.7';
const MUSE_MODEL = 'muse-spark-1.2-contributor';
const OX_MODEL = 'stealth/ox-alpha';
const vendorPackage = JSON.parse(await readFile(path.join(VENDOR, 'package.json'), 'utf8'));

function dshPeerNames(pkg) {
  const names = [];
  for (const [name, spec] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue;
    if (spec !== DSH_RC7) throw new Error(`${name} peerDependency must be exact ${DSH_RC7}, found ${spec}`);
    names.push(name);
  }
  if (!names.includes('@deepseek-ai/dsh-acp') || !names.includes('@deepseek-ai/dsh-agent-spine-demo')) {
    throw new Error('Vendored DSH demo must declare exact dsh-acp and dsh-agent-spine-demo peers.');
  }
  return names;
}

const dshPeers = dshPeerNames(vendorPackage);
const dshInstall = [...new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-local',
  ...dshPeers,
])].map((name) => `${name}@${DSH_RC7}`);

async function packageVersion(globalRoot, packageName) {
  const relative = `${packageName}/package.json`;
  const candidates = packageName.startsWith('@deepseek-ai/dsh-') && packageName !== '@deepseek-ai/dsh-acp-demo'
    ? [`@deepseek-ai/dsh-acp-demo/node_modules/${relative}`, relative]
    : [relative];
  let lastError;
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(path.join(globalRoot, candidate), 'utf8')).version;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function emitOutput(value) {
  process.stdout.write(value);
  if (!configuredOutputFile) return;
  await mkdir(path.dirname(configuredOutputFile), { recursive: true, mode: 0o700 });
  if (!outputFileInitialized) {
    await writeFile(configuredOutputFile, value, { encoding: 'utf8', mode: 0o600 });
    outputFileInitialized = true;
  } else {
    await appendFile(configuredOutputFile, value, { encoding: 'utf8', mode: 0o600 });
  }
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

async function validConfig(file, { provider, model, apiKeyEnv }) {
  try {
    const metadata = await stat(file);
    const value = await readFile(file, 'utf8');
    return metadata.isFile() && (metadata.mode & 0o077) === 0
      && value.includes("name: '@deepseek-ai/dsh-acp-demo'")
      && value.includes(`provider: ${provider}`)
      && value.includes(`model: ${model}`)
      && value.includes(`apiKeyEnv: ${apiKeyEnv}`);
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
    const globalRoot = configuredGlobalRoot
      ? path.resolve(configuredGlobalRoot)
      : (await run('npm', ['root', '--global'], { cwd: tmpdir(), env: childEnv, encoding: 'utf8', timeout: 10_000 })).stdout.trim();
    if (!path.isAbsolute(globalRoot)) throw new Error('npm global root did not resolve to an absolute path.');
    const versions = {};
    for (const [name, packageName, expected] of [
      ['dsh', '@deepseek-ai/dsh', DSH_RC7],
      ['dsh-acp-demo', '@deepseek-ai/dsh-acp-demo', DSH_RC7],
      ...dshPeers.map((packageName) => [packageName.slice('@deepseek-ai/'.length), packageName, DSH_RC7]),
      ['cursor-sdk', '@cursor/sdk', '1.0.28'],
      ['acpx', 'acpx', '0.13.0'],
    ]) {
      versions[name] = await packageVersion(globalRoot, packageName);
      if (versions[name] !== expected) throw new Error(`${name} expected ${expected}, found ${versions[name]}`);
    }
    results.packages = { ok: true, versions };
  } catch (error) {
    results.packages = { ok: false, output: error?.message ?? String(error) };
  }
  results.config = {
    ok: await validConfig(configFile, { provider: 'meta', model: MUSE_MODEL, apiKeyEnv: 'MODEL_API_KEY' }),
    path: configFile,
    model: MUSE_MODEL,
  };
  results.oxConfig = {
    ok: await validConfig(oxConfigFile, { provider: 'openrouter', model: OX_MODEL, apiKeyEnv: 'OPENROUTER_API_KEY' }),
    path: oxConfigFile,
    model: OX_MODEL,
  };
  try {
    const metadata = await stat(persistenceRoot);
    results.persistence = { ok: metadata.isDirectory() && (metadata.mode & 0o077) === 0, path: persistenceRoot };
  } catch (error) {
    results.persistence = { ok: false, path: persistenceRoot, output: error?.code ?? 'unavailable' };
  }
  await emitOutput(`${JSON.stringify(results, null, 2)}\n`);
  return Object.values(results).every((result) => result.ok);
}

async function install() {
  const staging = await mkdtemp(path.join(tmpdir(), 'co-engineer-dsh-acp-'));
  try {
    await run('npm', ['pack', VENDOR, '--pack-destination', staging], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const archives = (await readdir(staging)).filter((entry) => entry.endsWith('.tgz'));
    if (archives.length !== 1) throw new Error(`npm pack must create exactly one archive, found ${archives.length}.`);
    const archive = path.join(staging, archives[0]);
    await run('npm', [
      'install',
      '--global',
      '--no-audit',
      '--no-fund',
      'acpx@0.13.0',
      '@cursor/sdk@1.0.28',
      ...dshInstall,
      archive,
    ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  for (const directory of configDirs) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((!configuredConfigFile && directory === path.dirname(configFile))
      || (!configuredOxConfigFile && directory === path.dirname(oxConfigFile))) {
      await chmod(directory, 0o700);
    }
  }
  await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
  await chmod(persistenceRoot, 0o700);
  const museProviders = [
    '    providers:',
    '      meta:',
    '        displayName: Meta Model API',
    '        apiKeyEnv: MODEL_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://api.meta.ai/v1',
    '        models:',
    `          - id: ${MUSE_MODEL}`,
    '            name: Muse Spark 1.2 Contributor',
    '            contextWindow: 1048576',
    '            maxTokens: 131072',
    '            input: [text, image]',
  ];
  const oxProviders = [
    '    providers:',
    '      openrouter:',
    '        displayName: OpenRouter',
    '        apiKeyEnv: OPENROUTER_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://openrouter.ai/api/v1',
    '        reasoning: max',
    '        models:',
    `          - id: ${OX_MODEL}`,
    '            name: Ox Alpha',
    '            contextWindow: 1048576',
    '            maxTokens: 131072',
    '            input: [text, image]',
    '            reasoningEfforts:',
    '              low: low',
    '              high: high',
    '              max: max',
  ];
  const configYaml = ({ provider, model, providers }) => [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    ...providers,
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
    `    provider: ${provider}`,
    `    model: ${model}`,
    `    persistenceRoot: ${JSON.stringify(persistenceRoot)}`,
    '    persistenceCompression: none',
    "    persona: 'You are a trusted autonomous coding agent. Follow the client request, use available tools, run tests, and commit coherent implementation work.'",
    '    workspaceContext: false',
    '',
  ].join('\n');
  if (!await exists(configFile)) {
    await writeFile(
      configFile,
      configYaml({ provider: 'meta', model: MUSE_MODEL, providers: museProviders }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } else if (!await validConfig(configFile, { provider: 'meta', model: MUSE_MODEL, apiKeyEnv: 'MODEL_API_KEY' })) {
    throw new Error(`Existing DSH ACP config is incompatible or not owner-only: ${configFile}`);
  }
  if (!await exists(oxConfigFile)) {
    await writeFile(
      oxConfigFile,
      configYaml({ provider: 'openrouter', model: OX_MODEL, providers: oxProviders }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
  } else if (!await validConfig(oxConfigFile, { provider: 'openrouter', model: OX_MODEL, apiKeyEnv: 'OPENROUTER_API_KEY' })) {
    throw new Error(`Existing Ox Alpha DSH ACP config is incompatible or not owner-only: ${oxConfigFile}`);
  }
  await emitOutput(`Installed Co-Engineer agent dependencies (ACPX, Cursor SDK, and the cohesive DSH rc.7 ACP composition).\nDSH Muse config: ${configFile}\nDSH Ox Alpha config: ${oxConfigFile}\n`);
  if (!await check()) process.exitCode = 1;
}

if (process.argv.includes('--check')) {
  if (!await check()) process.exitCode = 1;
} else {
  await install();
}
