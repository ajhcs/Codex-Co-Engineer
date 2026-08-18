import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bundlePath = join(root, 'plugins/plumbob-harness-control/assets/acpx-runtime.mjs');
const manifestPath = join(root, 'plugins/plumbob-harness-control/assets/acpx-runtime.manifest.json');
const noticePath = join(root, 'plugins/plumbob-harness-control/assets/acpx-third-party-notices.md');
const lockPath = join(root, 'tools/acpx-vendor/package-lock.json');
const expectedExports = ['createAcpRuntime', 'createAgentRegistry', 'createRuntimeStore'];
const expectedAcpxIntegrity = 'sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==';
const registryOrigin = 'https://registry.npmjs.org';

const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function lockPackageName(lockPackagePath) {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(lockPackagePath);
  assert.ok(match, `unexpected non-flat lock package path: ${lockPackagePath}`);
  return match[1];
}

function exactRegistryTarball(name, version) {
  const tarballName = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return `${registryOrigin}/${name}/-/${tarballName}-${version}.tgz`;
}

test('embedded ACPX bundle is self-contained and exactly pinned', async () => {
  const [bundle, manifest, lock, notice] = await Promise.all([
    readFile(bundlePath),
    readFile(manifestPath, 'utf8').then(JSON.parse),
    readFile(lockPath),
    readFile(noticePath, 'utf8'),
  ]);

  assert.equal(manifest.schema, 1);
  assert.equal(manifest.bundle, 'acpx-runtime.mjs');
  assert.equal(sha512(bundle), manifest.bundle_sha512);
  assert.deepEqual(manifest.exports, expectedExports);
  assert.deepEqual(manifest.source, {
    package: 'acpx',
    version: '0.13.0',
    tag: 'v0.13.0',
    commit: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
    tarball_integrity: expectedAcpxIntegrity,
  });
  const lockJson = JSON.parse(lock);
  const lockInventory = Object.entries(lockJson.packages)
    .filter(([packagePath]) => packagePath !== '')
    .map(([packagePath, locked]) => {
      const name = lockPackageName(packagePath);
      assert.equal(
        locked.resolved,
        exactRegistryTarball(name, locked.version),
        `${name} must use its exact npm registry tarball URL`,
      );
      assert.match(locked.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/u);
      assert.ok(locked.license, `${name} must have a frozen license identifier`);
      return { name, ...locked };
    })
    .sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });
  assert.equal(lockJson.packages['node_modules/acpx'].version, '0.13.0');
  assert.equal(lockJson.packages['node_modules/acpx'].integrity, expectedAcpxIntegrity);
  assert.equal(lockJson.packages['node_modules/@agentclientprotocol/sdk'].version, '1.3.0');
  assert.equal(lockJson.packages['node_modules/esbuild'].version, '0.28.2');

  const bundledNames = ['@agentclientprotocol/sdk', 'acpx', 'zod'];
  const expectedBundledPackages = bundledNames.map((name) => {
    const locked = lockJson.packages[`node_modules/${name}`];
    return {
      name,
      version: locked.version,
      integrity: locked.integrity,
      resolved: locked.resolved,
      license: locked.license,
    };
  });
  assert.deepEqual(manifest.bundled_packages, expectedBundledPackages);
  const lockedSdk = expectedBundledPackages.find(
    ({ name }) => name === '@agentclientprotocol/sdk',
  );
  assert.deepEqual(manifest.dependencies.acp_sdk, {
    package: lockedSdk.name,
    version: lockedSdk.version,
    integrity: lockedSdk.integrity,
  });
  const lockedBundler = lockJson.packages['node_modules/esbuild'];
  assert.deepEqual(manifest.dependencies.bundler, {
    package: 'esbuild',
    version: lockedBundler.version,
    integrity: lockedBundler.integrity,
  });
  assert.equal(manifest.dependencies.lock_sha512, sha512(lock));
  assert.deepEqual(manifest.external_imports, [
    'node:child_process',
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:path',
    'node:readline/promises',
    'node:stream',
    'node:url',
    'node:util',
  ]);
  assert.equal(manifest.notice, 'acpx-third-party-notices.md');
  assert.deepEqual(manifest.reproducibility, {
    source_maps: false,
    ambient_cli_or_flows: false,
    dynamic_imports: false,
    non_node_external_imports: false,
    local_paths: false,
    generated_at: null,
    authoritative_build: 'clean_npm_ci_offline',
    offline_cache: 'preseeded_required',
  });

  assert.match(notice, /Exact lock SHA-512: `sha512-[A-Za-z0-9+/]+=*`/u);
  assert.match(notice, /requires a preseeded npm cache/u);
  const bundledNoticeSection = notice.slice(0, notice.indexOf('## Exact lock inventory'));
  assert.equal(
    (bundledNoticeSection.match(/^### /gmu) ?? []).length,
    expectedBundledPackages.length,
  );
  for (const dependency of expectedBundledPackages) {
    const heading = `### ${dependency.name}@${dependency.version}`;
    assert.equal(bundledNoticeSection.split(heading).length - 1, 1);
    assert.ok(bundledNoticeSection.includes([
      heading,
      '',
      `- License: ${dependency.license}`,
      `- Resolved: ${dependency.resolved}`,
      `- Integrity: ${dependency.integrity}`,
    ].join('\n')));
  }

  const inventorySection = notice.split('## Exact lock inventory\n\n')[1];
  assert.ok(inventorySection, 'the exact lock inventory section is required');
  assert.deepEqual(inventorySection.trimEnd().split('\n'), [
    '| Package | Version | License | Integrity | Resolved |',
    '| --- | --- | --- | --- | --- |',
    ...lockInventory.map((dependency) => (
      `| ${dependency.name} | ${dependency.version} | ${dependency.license} | ${dependency.integrity} | ${dependency.resolved} |`
    )),
  ]);

  const source = bundle.toString('utf8');
  const staticImports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)]
    .map(([, specifier]) => specifier);
  assert.ok(staticImports.length > 0, 'the bundle should retain only Node built-in imports');
  assert.ok(staticImports.every((specifier) => specifier.startsWith('node:')));
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(source, /sourceMappingURL|node_modules\/|tools\/acpx-vendor|\.acpxrc/u);
  assert.doesNotMatch(source, /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u);

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'acpx-bundle-clean-import-'));
  try {
    const cleanBundlePath = join(temporaryDirectory, 'acpx-runtime.mjs');
    await copyFile(bundlePath, cleanBundlePath);
    const moduleUrl = `${pathToFileURL(cleanBundlePath).href}?sha512=${encodeURIComponent(sha512(bundle))}`;
    const cleanModule = await import(moduleUrl);
    assert.deepEqual(Object.keys(cleanModule).sort(), expectedExports);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
