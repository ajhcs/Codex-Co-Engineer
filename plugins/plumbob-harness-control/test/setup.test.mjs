import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(HERE, '..', 'bin', 'setup.mjs');

const PACKAGE_PATHS = [
  ['dsh', '@deepseek-ai/dsh/package.json'],
  ['dsh-acp-demo', '@deepseek-ai/dsh-acp-demo/package.json'],
  ['dsh-acp', '@deepseek-ai/dsh-acp-demo/node_modules/@deepseek-ai/dsh-acp/package.json'],
  ['dsh-agent-spine-demo', '@deepseek-ai/dsh-acp-demo/node_modules/@deepseek-ai/dsh-agent-spine-demo/package.json'],
  ['cursor-sdk', '@cursor/sdk/package.json'],
  ['acpx', 'acpx/package.json'],
];

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

async function fixture({ includeWorktree = true, versions, configMode = 0o600 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'co-engineer-setup-test-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const globalRoot = path.join(root, 'global');
  const configFile = path.join(root, 'custom', 'dsh-acp.yml');
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
  await executable(path.join(bin, 'npm'), `#!/bin/sh
if [ "$1" = "root" ] && [ "$2" = "--global" ]; then
  printf '%s\\n' '${globalRoot}'
  exit 0
fi
exit 99
`);

  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await writeFile(configFile, [
    "- id: acp-agent",
    "  name: '@deepseek-ai/dsh-acp-demo'",
    '  config:',
    '    model: muse-spark-1.2-contributor',
    '    apiKeyEnv: MODEL_API_KEY',
    '',
  ].join('\n'), { encoding: 'utf8', mode: configMode });
  await chmod(configFile, configMode);

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
  };
  return { root, bin, configFile, environment, persistenceRoot };
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
    if (!error.stdout?.trim()) throw new Error(`${error.message}\n${error.stderr ?? ''}`);
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      value: JSON.parse(error.stdout),
    };
  }
  if (!child.stdout?.trim()) throw new Error(`setup returned no JSON\n${JSON.stringify(child)}`);
  return { code: 0, value: JSON.parse(child.stdout) };
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
    assert.equal(result.value.persistence.ok, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
