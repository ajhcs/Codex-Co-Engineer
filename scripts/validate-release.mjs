#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_IDENTITY } from '../plugins/plumbob-harness-control/mcp/preflight.mjs';
import { SERVER_IDENTITY as CURSOR_SERVER_IDENTITY } from '../plugins/cursor-cloud-control/mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  '.codex/release-gate.toml', '.github/workflows/ci.yml', '.gitignore',
  'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'config/configuration.example.json', 'config/configuration.schema.json',
  'docs/acp-and-orchestrator-adoption.md', 'docs/configuration.md',
  'docs/control-plane-reliability-plan.md', 'docs/data-handling.md',
  'docs/preflight-inspector.md', 'docs/provider-capability-map.md',
  'docs/release.md', 'docs/target-contract.md',
  'plugins/plumbob-harness-control/.codex-plugin/plugin.json',
  'plugins/plumbob-harness-control/.mcp.json',
  'plugins/plumbob-harness-control/package.json',
  'plugins/plumbob-harness-control/README.md',
  'plugins/plumbob-harness-control/skills/control-plumbob-agents/SKILL.md',
  'plugins/plumbob-harness-control/mcp/acp-bounded-proxy.mjs',
  'plugins/plumbob-harness-control/mcp/acp-event-ledger.mjs',
  'plugins/plumbob-harness-control/mcp/acp-provider-registry.mjs',
  'plugins/plumbob-harness-control/mcp/acp-resource-boundary.mjs',
  'plugins/plumbob-harness-control/mcp/acp-session-schema.mjs',
  'plugins/plumbob-harness-control/mcp/acpx-worker.mjs',
  'plugins/plumbob-harness-control/mcp/control.mjs',
  'plugins/plumbob-harness-control/mcp/daemon.mjs',
  'plugins/plumbob-harness-control/mcp/dsh.mjs',
  'plugins/plumbob-harness-control/mcp/grok-build.mjs',
  'plugins/plumbob-harness-control/mcp/grok-outer-runtime.mjs',
  'plugins/plumbob-harness-control/mcp/preflight.mjs',
  'plugins/plumbob-harness-control/mcp/server.mjs',
  'plugins/plumbob-harness-control/mcp/store.mjs',
  'plugins/plumbob-harness-control/mcp/state.mjs',
  'plugins/plumbob-harness-control/mcp/capacity.mjs',
  'plugins/plumbob-harness-control/mcp/dsh-receipt.mjs',
  'plugins/plumbob-harness-control/mcp/grok-outer-sandbox.mjs',
  'plugins/plumbob-harness-control/assets/acpx-runtime.mjs',
  'plugins/plumbob-harness-control/assets/acpx-runtime.manifest.json',
  'plugins/plumbob-harness-control/assets/acpx-third-party-notices.md',
  'plugins/plumbob-harness-control/assets/dsh-headless.patch.yml',
  'plugins/plumbob-harness-control/assets/dsh-headless-usage-runner.mjs',
  'plugins/plumbob-harness-control/test/acp-bounded-proxy.test.mjs',
  'plugins/plumbob-harness-control/test/acp-event-ledger.test.mjs',
  'plugins/plumbob-harness-control/test/acp-provider-registry.test.mjs',
  'plugins/plumbob-harness-control/test/acp-resource-boundary.test.mjs',
  'plugins/plumbob-harness-control/test/acp-session-schema.test.mjs',
  'plugins/plumbob-harness-control/test/acp-store.test.mjs',
  'plugins/plumbob-harness-control/test/acpx-bundle.test.mjs',
  'plugins/plumbob-harness-control/test/acpx-fake-agent.mjs',
  'plugins/plumbob-harness-control/test/acpx-worker.test.mjs',
  'plugins/plumbob-harness-control/test/branding.test.mjs',
  'plugins/plumbob-harness-control/test/state.test.mjs',
  'plugins/plumbob-harness-control/test/capacity.test.mjs',
  'plugins/plumbob-harness-control/test/control.test.mjs',
  'plugins/plumbob-harness-control/test/dsh-receipt.test.mjs',
  'plugins/plumbob-harness-control/test/dsh-headless-usage-runner.test.mjs',
  'plugins/plumbob-harness-control/test/dsh.test.mjs',
  'plugins/plumbob-harness-control/test/fixtures/grok-outer-fake.sh',
  'plugins/plumbob-harness-control/test/grok-build.test.mjs',
  'plugins/plumbob-harness-control/test/grok-outer-runtime.test.mjs',
  'plugins/plumbob-harness-control/test/grok-outer-sandbox.test.mjs',
  'plugins/plumbob-harness-control/test/server.test.mjs',
  'plugins/cursor-cloud-control/.codex-plugin/plugin.json',
  'plugins/cursor-cloud-control/.mcp.json',
  'plugins/cursor-cloud-control/package.json',
  'plugins/cursor-cloud-control/README.md',
  'plugins/cursor-cloud-control/mcp/server.mjs',
  'plugins/cursor-cloud-control/mcp/ledger.mjs',
  'plugins/cursor-cloud-control/skills/control-cursor-cloud-agents/SKILL.md',
  'plugins/cursor-cloud-control/test/client.test.mjs',
  'plugins/cursor-cloud-control/test/ledger.test.mjs',
  'scripts/release-prerequisites.mjs', 'scripts/validate-release.mjs',
  'scripts/inspector-preflight.mjs', 'scripts/cursor-inspector-preflight.mjs',
  'scripts/plugin-activation-fixture.mjs', 'scripts/target-fingerprint.mjs',
  'tools/acpx-vendor/build.mjs', 'tools/acpx-vendor/package-lock.json',
  'tools/acpx-vendor/package.json', 'tools/acpx-vendor/src/entry.mjs',
  'tools/acpx-vendor/publish-provenance.test.mjs',
  'tools/acpx-vendor/reproducible.test.mjs',
  'tools/acpx-vendor/verify-publish-provenance.mjs',
];

async function text(relative) {
  return readFile(path.join(ROOT, relative), 'utf8');
}

async function json(relative) {
  return JSON.parse(await text(relative));
}

function fail(message) {
  throw new Error(message);
}

function sha512(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function exactTarball(name, version) {
  const packageName = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${packageName}-${version}.tgz`;
}

for (const relative of required) {
  let entry;
  try {
    entry = await lstat(path.join(ROOT, relative));
  } catch (error) {
    fail(`Required release file is unavailable: ${relative} (${error.code ?? error.message}).`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    fail(`Required release file must be a regular non-symlink file: ${relative}.`);
  }
}

const nodeMajor = Number.parseInt(process.versions.node.split('.', 1)[0], 10);
if (nodeMajor !== 24) fail(`Release validation requires Node major 24 (found ${process.versions.node}).`);

const manifest = await json('plugins/plumbob-harness-control/.codex-plugin/plugin.json');
const packageJson = await json('plugins/plumbob-harness-control/package.json');
const cursorManifest = await json('plugins/cursor-cloud-control/.codex-plugin/plugin.json');
const cursorPackage = await json('plugins/cursor-cloud-control/package.json');
const vendorPackage = await json('tools/acpx-vendor/package.json');
const lockBytes = await readFile(path.join(ROOT, 'tools/acpx-vendor/package-lock.json'));
const lock = JSON.parse(lockBytes);
const runtimeManifest = await json('plugins/plumbob-harness-control/assets/acpx-runtime.manifest.json');
const configurationSchema = await json('config/configuration.schema.json');
const configurationExample = await json('config/configuration.example.json');

if (manifest.version !== '2.1.0' || packageJson.version !== '2.1.0'
  || SERVER_IDENTITY.version !== '2.1.0'
  || manifest.version !== packageJson.version
  || packageJson.version !== SERVER_IDENTITY.version) {
  fail('Co-Engineer manifest, package, and MCP server versions must remain pinned at 2.1.0.');
}
if (manifest.interface.displayName !== 'Codex-Co-Engineer') fail('Public display name mismatch.');
if (cursorManifest.version !== '0.2.0' || cursorPackage.version !== '0.2.0'
  || CURSOR_SERVER_IDENTITY.version !== '0.2.0'
  || cursorManifest.version !== cursorPackage.version
  || cursorPackage.version !== CURSOR_SERVER_IDENTITY.version) {
  fail('Cursor manifest, package, and MCP server versions must remain pinned at 0.2.0.');
}
if (cursorManifest.interface.displayName !== 'Cursor Cloud Control') fail('Cursor public display name mismatch.');
if (packageJson.scripts?.test !== 'node --no-warnings --test test/*.test.mjs') {
  fail('Co-Engineer package test script must explicitly select test/*.test.mjs.');
}
if (typeof cursorPackage.scripts?.test !== 'string' || !cursorPackage.scripts.test.includes('--test')) {
  fail('Cursor package test script is missing.');
}
if (JSON.stringify(packageJson.files) !== JSON.stringify([
  '.codex-plugin', '.mcp.json', 'README.md', 'assets', 'bin', 'mcp', 'skills', 'package.json',
])) {
  fail('Co-Engineer package inventory roots changed.');
}
if (JSON.stringify(cursorPackage.files) !== JSON.stringify([
  '.codex-plugin', '.mcp.json', 'README.md', 'mcp', 'skills', 'test', 'package.json',
])) {
  fail('Cursor package inventory roots changed.');
}

for (const section of ['transport', 'runtime', 'credentials', 'target', 'deadlines']) {
  if (configurationSchema.properties?.[section]?.additionalProperties !== false) {
    fail(`Configuration schema section ${section} must reject unknown fields.`);
  }
  if (configurationExample[section] === null || typeof configurationExample[section] !== 'object') {
    fail(`Configuration example is missing section ${section}.`);
  }
}
if (configurationSchema.additionalProperties !== false) fail('Configuration schema must reject unknown top-level fields.');
if (configurationExample.schema_version !== 'codex-co-engineer.config.v1'
  || configurationExample.target?.schema_version !== 'codex-co-engineer.target.v1'
  || configurationExample.target?.mode !== 'explicit') {
  fail('Configuration example must use the strict v1 explicit-target contract.');
}

if (vendorPackage.version !== '0.1.0'
  || vendorPackage.dependencies?.acpx !== '0.13.0'
  || vendorPackage.dependencies?.esbuild !== '0.28.2'
  || lock.name !== vendorPackage.name
  || lock.version !== vendorPackage.version
  || lock.packages?.['']?.dependencies?.acpx !== '0.13.0'
  || lock.packages?.['']?.dependencies?.esbuild !== '0.28.2') {
  fail('ACPX vendor package and lock pins changed.');
}
const locked = (name) => lock.packages?.[`node_modules/${name}`];
const exactPackages = {
  '@agentclientprotocol/sdk': '1.3.0',
  acpx: '0.13.0',
  esbuild: '0.28.2',
  zod: '4.4.3',
};
for (const [name, version] of Object.entries(exactPackages)) {
  const entry = locked(name);
  if (entry?.version !== version || typeof entry.integrity !== 'string'
    || entry.resolved !== exactTarball(name, version) || typeof entry.license !== 'string') {
    fail(`ACPX lock entry ${name} is not exact.`);
  }
}
if (runtimeManifest.schema !== 1 || runtimeManifest.bundle !== 'acpx-runtime.mjs'
  || runtimeManifest.source?.package !== 'acpx'
  || runtimeManifest.source?.version !== '0.13.0'
  || runtimeManifest.source?.tag !== 'v0.13.0'
  || runtimeManifest.source?.commit !== '47dc1c56b20da3c248a4a1b5c5106f52e65e6594'
  || runtimeManifest.source?.tarball_integrity !== locked('acpx').integrity) {
  fail('ACPX runtime manifest source pin changed.');
}
const runtimeBundle = await readFile(path.join(ROOT, 'plugins/plumbob-harness-control/assets/acpx-runtime.mjs'));
if (sha512(runtimeBundle) !== runtimeManifest.bundle_sha512) fail('ACPX runtime asset hash does not match its manifest.');
if (sha512(lockBytes) !== runtimeManifest.dependencies?.lock_sha512) fail('ACPX lock hash does not match its manifest.');
if (JSON.stringify(runtimeManifest.bundled_packages) !== JSON.stringify([
  '@agentclientprotocol/sdk', 'acpx', 'zod',
].map((name) => ({
  name,
  version: locked(name).version,
  integrity: locked(name).integrity,
  resolved: locked(name).resolved,
  license: locked(name).license,
})))) {
  fail('ACPX bundled package manifest inventory changed.');
}
if (runtimeManifest.dependencies?.bundler?.package !== 'esbuild'
  || runtimeManifest.dependencies.bundler.version !== locked('esbuild').version
  || runtimeManifest.dependencies.bundler.integrity !== locked('esbuild').integrity) {
  fail('ACPX bundler pin changed.');
}

const policy = await text('.codex/release-gate.toml');
if (!/^authority\s*=\s*"local-exact-tree"\s*$/mu.test(policy)) fail('Release policy authority must be local-exact-tree.');
const blocks = policy.split('[[stages]]').slice(1);
const expectedStages = [
  { name: 'release-prerequisites', kind: 'preflight', command: ['node', 'scripts/release-prerequisites.mjs'] },
  { name: 'release-validation', kind: 'preflight', command: ['node', 'scripts/validate-release.mjs'] },
  { name: 'acpx-bootstrap', kind: 'bootstrap', command: ['npm', '--prefix', 'tools/acpx-vendor', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
  { name: 'co-engineer-unit', kind: 'unit_tests', command: ['npm', '--prefix', 'plugins/plumbob-harness-control', 'test'] },
  { name: 'cursor-cloud-unit', kind: 'unit_tests', command: ['npm', '--prefix', 'plugins/cursor-cloud-control', 'test'] },
  { name: 'acpx-fake-provenance-unit', kind: 'unit_tests', command: ['npm', '--prefix', 'tools/acpx-vendor', 'run', 'test:publish-provenance'] },
  { name: 'plugin-activation-fixture', kind: 'integration_tests', command: ['node', 'scripts/plugin-activation-fixture.mjs'] },
  { name: 'grok-outer-real-bwrap', kind: 'integration_tests', command: ['node', '--test', 'plugins/plumbob-harness-control/test/grok-outer-sandbox.test.mjs'] },
  { name: 'mcp-inspector', kind: 'integration_tests', command: ['node', 'scripts/inspector-preflight.mjs'] },
  { name: 'cursor-mcp-preflight', kind: 'integration_tests', command: ['node', 'scripts/cursor-inspector-preflight.mjs'] },
  { name: 'acpx-reproducible-build', kind: 'build', command: ['npm', '--prefix', 'tools/acpx-vendor', 'run', 'test:reproducible'] },
  { name: 'acpx-publish-provenance', kind: 'security_checks', command: ['npm', '--prefix', 'tools/acpx-vendor', 'run', 'verify:publish-provenance'] },
  { name: 'co-engineer-package-inventory', kind: 'artifact_verification', command: ['npm', 'pack', './plugins/plumbob-harness-control', '--dry-run', '--ignore-scripts', '--offline', '--json'] },
  { name: 'cursor-package-inventory', kind: 'artifact_verification', command: ['npm', 'pack', './plugins/cursor-cloud-control', '--dry-run', '--ignore-scripts', '--offline', '--json'] },
];
function stageField(block, field) {
  return block.match(new RegExp(`^${field}\\s*=\\s*(.+)$`, 'mu'))?.[1]?.trim();
}
const actualStages = blocks.map((block) => {
  const name = stageField(block, 'name')?.match(/^"([^"]+)"$/u)?.[1];
  const kind = stageField(block, 'kind')?.match(/^"([^"]+)"$/u)?.[1];
  const commandValue = stageField(block, 'command');
  let command;
  try {
    command = JSON.parse(commandValue);
  } catch {
    command = null;
  }
  return { name, kind, command };
});
if (JSON.stringify(actualStages) !== JSON.stringify(expectedStages)
  || actualStages.filter((stage) => stage.kind === 'build').length !== 1) {
  fail('Release policy stage names, kinds, commands, or single-build invariant changed.');
}
if (!policy.includes('command = ["npm", "--prefix", "tools/acpx-vendor", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]')) {
  fail('Release policy must bootstrap the exact ACPX lock with npm ci and no scripts/audit/fund.');
}
const cachePath = '/tmp/codex-acpx-release-npm-cache';
for (const block of blocks) {
  if (/command = \["npm"/u.test(block)
    && (!block.includes(`ACPX_NPM_CACHE = "${cachePath}"`)
      || !block.includes(`NPM_CONFIG_CACHE = "${cachePath}"`))) {
    fail('Every npm release stage must use the fixed ACPX cache through stage env.');
  }
}
const outerBlock = blocks.find((block) => block.includes('name = "grok-outer-real-bwrap"')) ?? '';
if (!outerBlock.includes('GROK_OUTER_REQUIRE_REAL = "1"')) fail('Strict real Bubblewrap stage is not enabled.');
const ci = await text('.github/workflows/ci.yml');
if (!ci.includes('@modelcontextprotocol/inspector@2.2.0')) {
  fail('CI must provision the exact @modelcontextprotocol/inspector@2.2.0 package.');
}
if (/GROK_OUTER_REQUIRE_REAL:\s*['"]1['"]/u.test(ci)
  || ci.includes('node scripts/release-prerequisites.mjs')) {
  fail('Non-authoritative CI must not simulate the host-specific strict Bubblewrap stages.');
}
const prerequisiteSource = await text('scripts/release-prerequisites.mjs');
const obsoleteNetworkFlag = ['--unshare', 'net'].join('-');
const obsoleteRoutePath = ['/proc', 'net', 'route'].join('/');
if (prerequisiteSource.includes(obsoleteNetworkFlag)
  || !prerequisiteSource.includes("'--unshare-all'")
  || !prerequisiteSource.includes("'--share-net'")
  || !prerequisiteSource.includes("'--disable-userns'")
  || !prerequisiteSource.includes("'--assert-userns-disabled'")
  || !prerequisiteSource.includes("'--tmpfs'")
  || !prerequisiteSource.includes("'--ro-bind-fd'")
  || !prerequisiteSource.includes("'--bind-fd'")
  || prerequisiteSource.includes(obsoleteRoutePath)) {
  fail('Host prerequisite must use the production-shaped provider-free Bubblewrap boundary probe.');
}
for (const plugin of ['plumbob-harness-control', 'cursor-cloud-control']) {
  if (!policy.includes(`pack", "./plugins/${plugin}"`)
    || !policy.includes('"--dry-run", "--ignore-scripts", "--offline", "--json"')) {
    fail(`Release policy is missing the offline dry-run inventory for ${plugin}.`);
  }
}

// Keep the secret scan scoped to files owned by this release policy. It is
// intentionally not a recursive repository walk: the release gate validates
// the explicit candidate inventory above and must not absorb unrelated files.
const scanned = [
  '.codex/release-gate.toml', '.github/workflows/ci.yml', 'docs/release.md',
  'scripts/release-prerequisites.mjs', 'scripts/validate-release.mjs',
];
const forbidden = [
  new RegExp(`/${['home', 'plumbob'].join('/')}\\b`, 'g'),
  new RegExp(`/${['mnt', 'd', 'Coding Projects', 'CheapTesting'].join('/')}\\b`, 'g'),
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];
for (const relative of scanned) {
  const value = await text(relative);
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) fail(`Forbidden private material pattern in ${relative}.`);
  }
}

process.stdout.write(`release validation passed (${required.length} required files, Co-Engineer ${packageJson.version}, ACPX ${runtimeManifest.source.version})\n`);
