import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(HERE, '..', 'bin', 'setup.mjs');
const VENDOR_PACKAGE_PATH = path.resolve(HERE, '..', 'vendor', 'dsh-acp-demo', 'package.json');
const DSH_RC7 = '0.1.0-rc.7';
const REQUIRED_DSH_PEERS = [
  '@deepseek-ai/dsh-acp',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-agent-instructions',
];

const VENDOR_PACKAGE = JSON.parse(await readFile(VENDOR_PACKAGE_PATH, 'utf8'));
const DSH_PEERS = Object.keys(VENDOR_PACKAGE.peerDependencies ?? {})
  .filter((name) => name.startsWith('@deepseek-ai/dsh-'));

const PACKAGE_PATHS = [
  ['dsh', '@deepseek-ai/dsh/package.json'],
  ['dsh-acp-demo', '@deepseek-ai/dsh-acp-demo/package.json'],
  ...DSH_PEERS.map((name) => [
    name.slice('@deepseek-ai/'.length),
    `@deepseek-ai/dsh-acp-demo/node_modules/${name}/package.json`,
  ]),
  ['cursor-sdk', '@cursor/sdk/package.json'],
  ['acpx', 'acpx/package.json'],
];

async function loadNpmSemver() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'semver'),
  ];
  try {
    const { stdout } = await run('npm', ['root', '--global'], { encoding: 'utf8' });
    candidates.push(path.join(stdout.trim(), 'npm', 'node_modules', 'semver'));
  } catch {
    // Keep the Node-bundled npm candidate.
  }
  try {
    const { stdout } = await run('sh', ['-c', 'command -v npm'], { encoding: 'utf8' });
    const npmBin = stdout.trim();
    if (npmBin) {
      const resolved = await realpath(npmBin).catch(() => npmBin);
      // npm-cli.js lives at .../node_modules/npm/bin/npm-cli.js
      candidates.push(path.resolve(path.dirname(resolved), '..', 'node_modules', 'semver'));
      // Unresolved bin shims live at .../bin/npm beside .../lib/node_modules/npm
      candidates.push(path.resolve(path.dirname(npmBin), '..', 'lib', 'node_modules', 'npm', 'node_modules', 'semver'));
    }
  } catch {
    // Optional PATH-based npm discovery.
  }
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Unable to load npm bundled semver for DSH pin regression checks.');
}

async function executable(file, content) {
  await writeFile(file, content, { encoding: 'utf8', mode: 0o700 });
  await chmod(file, 0o700);
}

async function packageTree(root, versions = {}) {
  for (const [name, relative] of PACKAGE_PATHS) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify({ name, version: versions[name] ?? (name === 'cursor-sdk' ? '1.0.28' : name === 'acpx' ? '0.13.0' : '0.1.0-rc.7') })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

async function fixture({ includeWorktree = true, versions, configMode = 0o600, recordInstall = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-setup-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const globalRoot = path.join(root, 'global');
  const configFile = path.join(root, 'custom', 'dsh-acp.yml');
  const oxConfigFile = path.join(root, 'custom', 'dsh-acp-ox-alpha.yml');
  const persistenceRoot = path.join(stateHome, 'codex-co-engineer', 'dsh-sessions');
  await mkdir(bin, { recursive: true, mode: 0o700 });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
  await packageTree(globalRoot, versions);

  for (const [name, output] of [
    ['dsh', 'dsh-override'],
    ['acpx', 'acpx-override'],
    ['dsh-acp-demo', 'dsh-acp-override'],
  ]) {
    await executable(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  }
  if (includeWorktree) {
    await executable(path.join(bin, 'worktree-bootstrap'), '#!/bin/sh\nprintf \'%s\\n\' \'worktree-override\'\n');
  }
  const installArgsFile = path.join(root, 'npm-install.args');
  const setupOutputFile = path.join(root, 'setup-output.txt');
  await executable(path.join(bin, 'npm'), `#!/bin/sh
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\\n' '${globalRoot}'
  exit 0
fi
${recordInstall ? `if [ "$1" = "pack" ]; then
  dest=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--pack-destination" ]; then
      dest="$arg"
    fi
    prev="$arg"
  done
  if [ -z "$dest" ]; then
    exit 99
  fi
  : > "$dest/fake.tgz"
  printf '%s\\n' 'fake.tgz'
  exit 0
fi
if [ "$1" = "install" ]; then
  : > '${installArgsFile}'
  for arg in "$@"; do
    printf '%s\\n' "$arg" >> '${installArgsFile}'
  done
  exit 0
fi
` : ''}exit 99
`);

  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, [
    "- id: acp-agent",
    "  name: '@deepseek-ai/dsh-acp-demo'",
    '  config:',
    '    provider: meta',
    '    model: muse-spark-1.2-contributor',
    '    apiKeyEnv: MODEL_API_KEY',
    '',
  ].join('\n'), { encoding: 'utf8', mode: configMode });
  await chmod(configFile, configMode);
  await writeFile(oxConfigFile, [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      openrouter:',
    '        apiKeyEnv: OPENROUTER_API_KEY',
    '        api: openai-completions',
    '        baseURL: https://openrouter.ai/api/v1',
    '        reasoning: max',
    '        models:',
    '          - id: stealth/ox-alpha',
    '            contextWindow: 1048576',
    '            maxTokens: 131072',
    '            reasoningEfforts:',
    '              low: low',
    '              high: high',
    '              max: max',
    '- id: acp-agent',
    "  name: '@deepseek-ai/dsh-acp-demo'",
    '  config:',
    '    provider: openrouter',
    '    model: stealth/ox-alpha',
    '',
  ].join('\n'), { encoding: 'utf8', mode: configMode });
  await chmod(oxConfigFile, configMode);

  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    PATH: bin,
    CODEX_CO_ENGINEER_DSH_COMMAND: path.join(bin, 'dsh'),
    CODEX_CO_ENGINEER_ACPX_COMMAND: path.join(bin, 'acpx'),
    CODEX_CO_ENGINEER_DSH_ACP_COMMAND: path.join(bin, 'dsh-acp-demo'),
    CODEX_CO_ENGINEER_DSH_ACP_CONFIG: configFile,
    CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG: oxConfigFile,
    CODEX_CO_ENGINEER_NPM_GLOBAL_ROOT: globalRoot,
    CODEX_CO_ENGINEER_SETUP_OUTPUT_FILE: setupOutputFile,
  };
  return { root, bin, configFile, oxConfigFile, environment, persistenceRoot, installArgsFile, setupOutputFile };
}

async function runCheck(environment) {
  let child;
  try {
    child = await run(process.execPath, [SETUP, '--check'], {
      cwd: path.dirname(SETUP),
      env: environment,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const output = error.stdout?.trim()
      ? error.stdout
      : await readFile(environment.CODEX_CO_ENGINEER_SETUP_OUTPUT_FILE, 'utf8').catch(() => '');
    if (!output.trim()) throw new Error(`${error.message}\n${error.stderr ?? ''}`);
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      value: JSON.parse(output),
    };
  }
  const output = child.stdout?.trim() ? child.stdout : await readFile(environment.CODEX_CO_ENGINEER_SETUP_OUTPUT_FILE, 'utf8');
  if (!output?.trim()) throw new Error(`setup returned no JSON\n${JSON.stringify(child)}`);
  return { code: 0, value: JSON.parse(output) };
}

test('setup check honors command and config overrides and verifies worktree-bootstrap', async () => {
  const value = await fixture();
  try {
    const result = await runCheck(value.environment);
    assert.equal(result.code, 0);
    assert.equal(result.value.dsh.output, 'dsh-override');
    assert.equal(result.value.acpx.output, 'acpx-override');
    assert.equal(result.value.dshAcp.output, path.join(value.bin, 'dsh-acp-demo'));
    assert.equal(result.value.worktreeBootstrap.output, 'worktree-override');
    assert.equal(result.value.config.path, value.configFile);
    assert.equal(result.value.config.ok, true);
    assert.equal(result.value.oxConfig.path, value.oxConfigFile);
    assert.equal(result.value.oxConfig.ok, true);
    assert.equal(result.value.oxConfig.model, 'stealth/ox-alpha');
    assert.equal(result.value.persistence.path, value.persistenceRoot);
    assert.equal(result.value.persistence.ok, true);
    assert.equal(result.value.packages.ok, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('setup check fails closed when worktree-bootstrap is unavailable', async () => {
  const value = await fixture({ includeWorktree: false });
  try {
    const result = await runCheck(value.environment);
    assert.equal(result.code, 1);
    assert.equal(result.value.worktreeBootstrap.ok, false);
    assert.equal(result.value.config.ok, true);
    assert.equal(result.value.oxConfig.ok, true);
    assert.equal(result.value.packages.ok, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('setup check preserves exact package versions and owner-only config validation', async () => {
  const value = await fixture({ versions: { dsh: '0.1.0-rc.6' }, configMode: 0o644 });
  try {
    const result = await runCheck(value.environment);
    assert.equal(result.code, 1);
    assert.equal(result.value.packages.ok, false);
    assert.equal(result.value.config.ok, false);
    assert.equal(result.value.oxConfig.ok, false);
    assert.equal(result.value.persistence.ok, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('vendored DSH rc.7 peers are exact pins that reject later prereleases', async () => {
  const semver = await loadNpmSemver();
  assert.equal(semver.satisfies('0.1.0-rc.8', '^0.1.0-rc.7'), true);
  assert.equal(semver.satisfies('0.1.0-rc.8', '0.1.0-rc.7'), false);

  for (const name of REQUIRED_DSH_PEERS) {
    assert.equal(VENDOR_PACKAGE.peerDependencies[name], DSH_RC7, `${name} must be an exact ${DSH_RC7} pin`);
  }
  assert.ok(DSH_PEERS.length >= REQUIRED_DSH_PEERS.length);
  for (const name of DSH_PEERS) {
    const spec = VENDOR_PACKAGE.peerDependencies[name];
    assert.equal(spec, DSH_RC7, `${name} must pin exact ${DSH_RC7}, found ${spec}`);
    assert.equal(/[\^~><*= |]/u.test(spec), false, `${name} must not use a version range`);
    assert.equal(semver.satisfies(DSH_RC7, spec), true, `${name}@${spec} must accept ${DSH_RC7}`);
    assert.equal(semver.satisfies('0.1.0-rc.8', spec), false, `${name}@${spec} must not resolve 0.1.0-rc.8`);
    assert.equal(semver.satisfies('0.1.0', spec), false, `${name}@${spec} must not resolve a later non-prerelease`);
  }
});

test('setup check rejects a later dsh-acp prerelease', async () => {
  const value = await fixture({ versions: { 'dsh-acp': '0.1.0-rc.8' } });
  try {
    const result = await runCheck(value.environment);
    assert.equal(result.code, 1);
    assert.equal(result.value.packages.ok, false);
    assert.match(result.value.packages.output, /dsh-acp expected 0\.1\.0-rc\.7, found 0\.1\.0-rc\.8/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('setup install pins the exact DSH rc.7 composition', async () => {
  const value = await fixture({ recordInstall: true });
  try {
    await rm(value.configFile);
    await rm(value.oxConfigFile);
    const child = await run(process.execPath, [SETUP], {
      cwd: path.dirname(SETUP),
      env: value.environment,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    const args = (await readFile(value.installArgsFile, 'utf8')).trim().split('\n');
    assert.deepEqual(args.slice(0, 5), ['install', '--global', '--no-audit', '--no-fund', 'acpx@0.13.0']);
    assert.equal(args[5], '@cursor/sdk@1.0.28');
    for (const name of [
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-bash-local',
      ...REQUIRED_DSH_PEERS,
    ]) {
      assert.ok(args.includes(`${name}@${DSH_RC7}`), `setup must explicitly install ${name}@${DSH_RC7}`);
    }
    assert.ok(args.at(-1)?.endsWith('fake.tgz'));
    const museConfig = await readFile(value.configFile, 'utf8');
    assert.match(museConfig, /provider: meta/u);
    assert.match(museConfig, /model: muse-spark-1\.2-contributor/u);
    assert.match(museConfig, /apiKeyEnv: MODEL_API_KEY/u);
    assert.doesNotMatch(museConfig, /openrouter|OPENROUTER_API_KEY|stealth\/ox-alpha/u);
    const oxConfig = await readFile(value.oxConfigFile, 'utf8');
    assert.match(oxConfig, /provider: openrouter/u);
    assert.match(oxConfig, /model: stealth\/ox-alpha/u);
    assert.match(oxConfig, /apiKeyEnv: OPENROUTER_API_KEY/u);
    assert.match(oxConfig, /baseURL: https:\/\/openrouter\.ai\/api\/v1/u);
    assert.match(oxConfig, /reasoning: max/u);
    assert.match(oxConfig, /reasoningEfforts:\n\s+low: low\n\s+high: high\n\s+max: max/u);
    assert.doesNotMatch(oxConfig, /api\.meta\.ai|MODEL_API_KEY|muse-spark-1\.2-contributor/u);
    const setupOutput = child.stdout?.trim() ? child.stdout : await readFile(value.setupOutputFile, 'utf8');
    assert.match(setupOutput, /Installed Co-Engineer agent dependencies/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
