import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');
const entry = resolve(here, 'src/entry.mjs');
const lockPath = join(here, 'package-lock.json');
const packagePath = join(here, 'package.json');
const defaultOutputDirectory = join(
  repositoryRoot,
  'plugins/plumbob-harness-control/assets',
);

const BUNDLE_NAME = 'acpx-runtime.mjs';
const MANIFEST_NAME = 'acpx-runtime.manifest.json';
const NOTICE_NAME = 'acpx-third-party-notices.md';
const HARDENING_OVERLAY_FILE = 'src/hardening-overlay.mjs';
const HARDENING_OVERLAY_SOURCE = 'tools/acpx-vendor/src/hardening-overlay.mjs';
const HARDENING_OVERLAY_SEPARATOR = '\n';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const EXPECTED_EXPORTS = [
  'createAcpRuntime',
  'createAgentRegistry',
  'createRuntimeStore',
];
const EXPECTED_RUNTIME_PACKAGES = [
  '@agentclientprotocol/sdk',
  'acpx',
  'zod',
];
const EXPECTED_ACPX = {
  version: '0.13.0',
  integrity: 'sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==',
  commit: '47dc1c56b20da3c248a4a1b5c5106f52e65e6594',
};
const EXPECTED_BUNDLER = { name: 'esbuild', version: '0.28.2' };

function parseOutputDirectory(argv) {
  if (argv.length === 0) return defaultOutputDirectory;
  if (
    argv.length !== 2
    || argv[0] !== '--output-dir'
    || typeof argv[1] !== 'string'
    || argv[1].trim().length === 0
  ) {
    throw new Error('Usage: node build.mjs [--output-dir <directory>]');
  }
  return resolve(process.cwd(), argv[1]);
}

function sha512(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertExact(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
}

function packageNameFromInput(input) {
  const normalized = input.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (parts[0] !== 'node_modules') return null;
  if (parts[1]?.startsWith('@')) return parts.slice(1, 3).join('/');
  return parts[1] ?? null;
}

function packageNameFromLockPath(lockPackagePath) {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(lockPackagePath);
  assert.ok(match, `Unsupported non-flat lock package path: ${lockPackagePath}`);
  return match[1];
}

function exactRegistryTarball(name, version) {
  const tarballName = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return `${REGISTRY_ORIGIN}/${name}/-/${tarballName}-${version}.tgz`;
}

function assertBuildGraph(metafile, bundlePath) {
  const outputs = Object.entries(metafile.outputs);
  assert.equal(outputs.length, 1, 'The ACPX build must emit exactly one JavaScript bundle.');
  const [outputKey, output] = outputs[0];
  assert.equal(resolve(here, outputKey), bundlePath, 'The metafile output path must match the requested bundle.');
  assert.equal(resolve(here, output.entryPoint), entry, 'The bundle must originate from the audited runtime shim.');
  assertExact(output.exports, EXPECTED_EXPORTS, 'The emitted export surface changed.');

  const inputEntries = Object.entries(metafile.inputs);
  const inputPaths = inputEntries.map(([input]) => input.replaceAll('\\', '/'));
  const sourceInputs = inputPaths.filter((input) => !input.startsWith('node_modules/'));
  assert.deepEqual(sourceInputs, ['src/entry.mjs'], 'Unexpected local source entered the ACPX runtime bundle.');
  assert.equal(
    inputPaths.some((input) => /node_modules\/acpx\/dist\/(?:cli|flows)(?:[-.][^/]*)?\.js$/u.test(input)),
    false,
    'ACPX CLI or flows code entered the runtime bundle.',
  );

  const runtimePackageNames = sortedUnique(
    inputPaths.map(packageNameFromInput).filter((name) => name !== null),
  );
  assertExact(
    runtimePackageNames,
    EXPECTED_RUNTIME_PACKAGES,
    'The exact bundled runtime package inventory changed.',
  );

  const inputImports = inputEntries.flatMap(([, input]) => input.imports);
  const allImports = [...inputImports, ...output.imports];
  assert.equal(
    allImports.some(({ kind }) => kind === 'dynamic-import'),
    false,
    'Dynamic imports are forbidden in the embedded runtime bundle.',
  );
  const externalImports = allImports.filter(({ external }) => external);
  assert.equal(
    externalImports.some(({ path }) => !path.startsWith('node:')),
    false,
    'Only Node built-ins may remain external to the embedded runtime bundle.',
  );
  assert.equal(
    output.imports.some(({ external }) => !external),
    false,
    'Every emitted import must be an explicitly audited external Node built-in.',
  );
  assert.equal(
    output.imports.some(({ kind }) => kind !== 'import-statement'),
    false,
    'The ESM bundle may contain only static import statements.',
  );

  return {
    exports: [...output.exports].sort(),
    externalImports: sortedUnique(output.imports.map(({ path }) => path)),
    inputPaths,
    runtimePackageNames,
  };
}

function assertBundleText(bundleBytes, bundlePath, outputDirectory, graph) {
  const source = bundleBytes.toString('utf8');
  const staticImports = sortedUnique(
    [...source.matchAll(/\bfrom\s*["']([^"']+)["']/gu)].map(([, specifier]) => specifier),
  );
  assert.deepEqual(
    staticImports,
    graph.externalImports,
    'The static imports in the emitted bundle do not match the audited metafile.',
  );
  assert.equal(/\bimport\s*\(/u.test(source), false, 'Dynamic import syntax is forbidden.');
  assert.equal(/sourceMappingURL|sourceURL=/u.test(source), false, 'Source maps are forbidden.');
  assert.equal(
    /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/u.test(source),
    false,
    'Build timestamps are forbidden.',
  );
  assert.equal(source.includes('.acpxrc'), false, 'Ambient ACPX configuration references are forbidden.');

  const exactLocalMarkers = sortedUnique([
    here,
    repositoryRoot,
    entry,
    bundlePath,
    outputDirectory,
    pathToFileURL(here).href,
    pathToFileURL(entry).href,
    pathToFileURL(bundlePath).href,
    ...graph.inputPaths,
  ].filter((marker) => marker.length > 1));
  const leakedMarker = exactLocalMarkers.find((marker) => source.includes(marker));
  assert.equal(leakedMarker, undefined, `Local build path leaked into the bundle: ${leakedMarker}`);
}

async function packageLicenseFile(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const candidate = entries
    .filter((entry) => entry.isFile() && /^licen[cs]e(?:\.[^.]+)?$/iu.test(entry.name))
    .sort((left, right) => compareText(left.name, right.name))[0];
  return candidate ? join(packageDirectory, candidate.name) : null;
}

async function bundledPackageRecords(runtimePackageNames, lock) {
  const records = [];
  for (const name of runtimePackageNames) {
    const lockEntry = lock.packages[`node_modules/${name}`];
    assert.ok(lockEntry?.version, `Runtime package ${name} is missing an exact version.`);
    assert.ok(lockEntry.integrity, `Runtime package ${name} is missing exact integrity.`);
    assert.ok(lockEntry.resolved, `Runtime package ${name} is missing an exact resolved URL.`);
    assert.equal(
      lockEntry.resolved,
      exactRegistryTarball(name, lockEntry.version),
      `Runtime package ${name} did not resolve from its exact npm registry tarball.`,
    );
    assert.ok(lockEntry.license, `Runtime package ${name} is missing a license identifier.`);

    const packageDirectory = join(here, 'node_modules', name);
    const packageJson = JSON.parse(
      await readFile(join(packageDirectory, 'package.json'), 'utf8'),
    );
    assert.equal(packageJson.name, name, `Installed package identity mismatch for ${name}.`);
    assert.equal(packageJson.version, lockEntry.version, `Installed version mismatch for ${name}.`);
    assert.equal(packageJson.license, lockEntry.license, `Installed license mismatch for ${name}.`);

    const licensePath = await packageLicenseFile(packageDirectory);
    assert.ok(licensePath, `Runtime package ${name} has no license file.`);
    records.push({
      name,
      version: lockEntry.version,
      integrity: lockEntry.integrity,
      resolved: lockEntry.resolved,
      license: lockEntry.license,
      licenseText: (await readFile(licensePath, 'utf8')).trim(),
    });
  }
  return records.sort((left, right) => compareText(left.name, right.name));
}

function exactLockInventory(lock) {
  return Object.entries(lock.packages)
    .filter(([name]) => name !== '')
    .map(([lockPackagePath, value]) => {
      const name = packageNameFromLockPath(lockPackagePath);
      assert.ok(value.version, `${lockPackagePath} is missing a locked version.`);
      assert.ok(value.integrity, `${lockPackagePath} is missing locked integrity.`);
      assert.equal(
        value.resolved,
        exactRegistryTarball(name, value.version),
        `${lockPackagePath} did not resolve from its exact npm registry tarball.`,
      );
      assert.ok(value.license, `${lockPackagePath} is missing a locked license identifier.`);
      return {
        name,
        version: value.version,
        license: value.license,
        integrity: value.integrity,
        resolved: value.resolved,
      };
    })
    .sort((left, right) => compareText(left.name, right.name));
}

function noticeText(packages, lockInventory, lockDigest) {
  const lines = [
    '# Third-party notices for the embedded ACPX runtime',
    '',
    'This file is generated by `tools/acpx-vendor/build.mjs` from the exact',
    '`tools/acpx-vendor/package-lock.json`. The runtime bundle includes the',
    'runtime packages listed below; the complete lock inventory records the',
    'pinned build and transitive dependency provenance used to produce it.',
    'Authoritative reproduction uses `npm ci --offline` in a clean temporary',
    'tree and therefore requires a preseeded npm cache; it does not claim an',
    'empty-cache or network-free dependency bootstrap.',
    '',
    `Exact lock SHA-512: \`${lockDigest}\``,
    '',
    '## Bundled runtime licenses',
    '',
  ];
  for (const dependency of packages) {
    lines.push(
      `### ${dependency.name}@${dependency.version}`,
      '',
      `- License: ${dependency.license}`,
      `- Resolved: ${dependency.resolved}`,
      `- Integrity: ${dependency.integrity}`,
      '',
      '```text',
      dependency.licenseText,
      '```',
      '',
    );
  }
  lines.push(
    '## Exact lock inventory',
    '',
    '| Package | Version | License | Integrity | Resolved |',
    '| --- | --- | --- | --- | --- |',
    ...lockInventory.map((dependency) => (
      `| ${dependency.name} | ${dependency.version} | ${dependency.license} | ${dependency.integrity} | ${dependency.resolved} |`
    )),
    '',
  );
  return lines.join('\n');
}

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
const bundlePath = join(outputDirectory, BUNDLE_NAME);
const manifestPath = join(outputDirectory, MANIFEST_NAME);
const noticePath = join(outputDirectory, NOTICE_NAME);
await mkdir(outputDirectory, { recursive: true });

const [lockBytes, vendorPackageJson, hardeningOverlayBytes] = await Promise.all([
  readFile(lockPath),
  readFile(packagePath, 'utf8').then(JSON.parse),
  readFile(join(here, HARDENING_OVERLAY_FILE)),
]);
const lockDigest = sha512(lockBytes);
const hardeningOverlayDigest = sha512(hardeningOverlayBytes);
assert.ok(hardeningOverlayBytes.length > 0, 'The ACPX hardening overlay must not be empty.');
const lock = JSON.parse(lockBytes);
const lockedAcpx = lock.packages['node_modules/acpx'];
const lockedBundler = lock.packages[`node_modules/${EXPECTED_BUNDLER.name}`];
assert.equal(vendorPackageJson.dependencies.acpx, EXPECTED_ACPX.version);
assert.equal(vendorPackageJson.dependencies[EXPECTED_BUNDLER.name], EXPECTED_BUNDLER.version);
assert.equal(lockedAcpx?.version, EXPECTED_ACPX.version);
assert.equal(lockedAcpx?.integrity, EXPECTED_ACPX.integrity);
assert.equal(lockedBundler?.version, EXPECTED_BUNDLER.version);

const result = await build({
  absWorkingDir: here,
  entryPoints: [entry],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  packages: 'bundle',
  treeShaking: true,
  minifySyntax: true,
  minifyWhitespace: true,
  sourcemap: false,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'silent',
  metafile: true,
});

const graph = assertBuildGraph(result.metafile, bundlePath);
const upstreamBundleBytes = await readFile(bundlePath);
const upstreamBundleDigest = sha512(upstreamBundleBytes);
const bundleBytes = Buffer.concat([
  upstreamBundleBytes,
  Buffer.from(HARDENING_OVERLAY_SEPARATOR, 'utf8'),
  hardeningOverlayBytes,
]);
await writeFile(bundlePath, bundleBytes);
const bundleDigest = sha512(bundleBytes);
assertBundleText(bundleBytes, bundlePath, outputDirectory, graph);
const importedBundle = await import(
  `${pathToFileURL(bundlePath).href}?integrity=${encodeURIComponent(bundleDigest)}`
);
assertExact(
  Object.keys(importedBundle),
  EXPECTED_EXPORTS,
  'The importable runtime export surface changed.',
);

const packageRecords = await bundledPackageRecords(graph.runtimePackageNames, lock);
const manifestPackages = packageRecords.map(({ licenseText: _licenseText, ...record }) => record);
const acpSdk = manifestPackages.find(({ name }) => name === '@agentclientprotocol/sdk');
assert.ok(acpSdk, 'The audited runtime graph does not contain the ACP SDK.');
const lockInventory = exactLockInventory(lock);
await writeFile(noticePath, noticeText(packageRecords, lockInventory, lockDigest), 'utf8');

const manifest = {
  schema: 1,
  bundle: BUNDLE_NAME,
  bundle_sha512: bundleDigest,
  exports: graph.exports,
  source: {
    package: 'acpx',
    version: lockedAcpx.version,
    tag: `v${lockedAcpx.version}`,
    commit: EXPECTED_ACPX.commit,
    tarball_integrity: lockedAcpx.integrity,
    upstream_bundle_sha512: upstreamBundleDigest,
  },
  hardening_overlay: {
    path: HARDENING_OVERLAY_SOURCE,
    sha512: hardeningOverlayDigest,
    application: 'append_after_upstream_bundle',
  },
  bundled_packages: manifestPackages,
  dependencies: {
    acp_sdk: {
      package: acpSdk.name,
      version: acpSdk.version,
      integrity: acpSdk.integrity,
    },
    lock_sha512: lockDigest,
    bundler: {
      package: EXPECTED_BUNDLER.name,
      version: lockedBundler.version,
      integrity: lockedBundler.integrity,
    },
  },
  external_imports: graph.externalImports,
  notice: NOTICE_NAME,
  reproducibility: {
    source_maps: false,
    ambient_cli_or_flows: false,
    dynamic_imports: false,
    non_node_external_imports: false,
    local_paths: false,
    generated_at: null,
    authoritative_build: 'clean_npm_ci_offline',
    offline_cache: 'preseeded_required',
  },
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
