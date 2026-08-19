import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const vendorRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(vendorRoot, '..', '..');
const checkedAssets = join(
  repositoryRoot,
  'plugins/plumbob-harness-control/assets',
);
const ASSET_NAMES = [
  'acpx-runtime.mjs',
  'acpx-runtime.manifest.json',
  'acpx-third-party-notices.md',
];
const VENDOR_FILES = [
  'build.mjs',
  'package-lock.json',
  'package.json',
  'src/entry.mjs',
  'src/hardening-overlay.mjs',
];
const CACHE_UNAVAILABLE_CODE = 'ACPX_REPRO_CACHE_UNAVAILABLE';
const INSTALL_FAILED_CODE = 'ACPX_REPRO_INSTALL_FAILED';

function stableEnvironmentError(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  return error;
}

function configuredNpmCache() {
  const configured = process.env.ACPX_NPM_CACHE
    ?? process.env.npm_config_cache
    ?? process.env.NPM_CONFIG_CACHE;
  if (configured !== undefined) return configured;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'npm-cache');
  }
  return join(homedir(), '.npm');
}

async function requireOfflineCache(cachePath) {
  if (
    typeof cachePath !== 'string'
    || cachePath.length < 1
    || cachePath.length > 4096
    || !isAbsolute(cachePath)
  ) {
    throw stableEnvironmentError(
      CACHE_UNAVAILABLE_CODE,
      'Set ACPX_NPM_CACHE to an absolute preseeded npm cache directory.',
    );
  }
  try {
    const cacheStat = await lstat(cachePath);
    if (!cacheStat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw stableEnvironmentError(
      CACHE_UNAVAILABLE_CODE,
      'The preseeded npm cache directory is unavailable.',
    );
  }
}

function classifyOfflineInstallFailure(error) {
  const boundedDiagnostic = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`
    .slice(0, 256 * 1024);
  if (/ENOTCACHED|only-if-cached|offline[^\n]*cache|cache[^\n]*miss/iu.test(boundedDiagnostic)) {
    return stableEnvironmentError(
      CACHE_UNAVAILABLE_CODE,
      'The npm cache does not contain every tarball required by the frozen lock.',
    );
  }
  return stableEnvironmentError(
    INSTALL_FAILED_CODE,
    'npm ci could not materialize the exact frozen lock in the clean tree.',
  );
}

function sanitizedChildEnvironment(cachePath, userConfig, globalConfig) {
  const environment = {
    FORCE_COLOR: '0',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    npm_config_cache: cachePath,
    npm_config_fund: 'false',
    npm_config_globalconfig: globalConfig,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: userConfig,
  };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 64 * 1024) {
      environment[key] = value;
    }
  }
  return environment;
}

async function copyVendorFile(sourceRoot, destinationRoot, relativePath) {
  const destination = join(destinationRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(sourceRoot, relativePath), destination);
}

async function assertSameFiles(leftDirectory, rightDirectory) {
  for (const name of ASSET_NAMES) {
    const [left, right] = await Promise.all([
      readFile(join(leftDirectory, name)),
      readFile(join(rightDirectory, name)),
    ]);
    assert.deepEqual(left, right, `${name} is not byte-for-byte reproducible.`);
  }
}

test('offline cache prerequisite has a stable failure code', async () => {
  await assert.rejects(
    requireOfflineCache(join(tmpdir(), `acpx-cache-missing-${process.pid}`)),
    (error) => error.code === CACHE_UNAVAILABLE_CODE,
  );
  assert.equal(
    classifyOfflineInstallFailure({ stderr: 'npm error code ENOTCACHED' }).code,
    CACHE_UNAVAILABLE_CODE,
  );
});

test('clean frozen offline install reproduces every checked-in ACPX asset', {
  timeout: 120_000,
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'acpx-vendor-reproducible-'));
  const cleanVendorRoot = join(temporaryRoot, 'vendor');
  const cleanOutput = join(temporaryRoot, 'output');
  const userConfig = join(temporaryRoot, 'user.npmrc');
  const globalConfig = join(temporaryRoot, 'global.npmrc');
  const cachePath = configuredNpmCache();
  try {
    await requireOfflineCache(cachePath);
    await Promise.all(
      VENDOR_FILES.map((relativePath) => (
        copyVendorFile(vendorRoot, cleanVendorRoot, relativePath)
      )),
    );
    await assert.rejects(
      access(join(cleanVendorRoot, 'node_modules')),
      { code: 'ENOENT' },
      'The reproducibility fixture must start without node_modules.',
    );

    const copiedLockBeforeInstall = await readFile(join(cleanVendorRoot, 'package-lock.json'));
    await Promise.all([
      writeFile(userConfig, 'registry=https://registry.npmjs.org/\nalways-auth=false\n', 'utf8'),
      writeFile(globalConfig, '', 'utf8'),
    ]);
    const childEnvironment = sanitizedChildEnvironment(
      cachePath,
      userConfig,
      globalConfig,
    );
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      await execFile(npmCommand, [
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ], {
        cwd: cleanVendorRoot,
        encoding: 'utf8',
        env: childEnvironment,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024,
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (error) {
      throw classifyOfflineInstallFailure(error);
    }
    assert.deepEqual(
      await readFile(join(cleanVendorRoot, 'package-lock.json')),
      copiedLockBeforeInstall,
      'npm ci changed the frozen lockfile.',
    );

    await execFile(process.execPath, [
      join(cleanVendorRoot, 'build.mjs'),
      '--output-dir',
      cleanOutput,
    ], {
      cwd: cleanVendorRoot,
      env: { ...childEnvironment, NODE_NO_WARNINGS: '1' },
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });

    await assertSameFiles(cleanOutput, checkedAssets);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
