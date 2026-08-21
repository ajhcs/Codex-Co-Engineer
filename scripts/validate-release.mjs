#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compactTaskCard } from '../plugins/codex-co-engineer/mcp/v3/diagnostics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = 'plugins/codex-co-engineer';
const RELEASE_VERSION = '3.2.1';

function fail(message) { throw new Error(message); }
const absolute = (relative) => path.join(ROOT, relative);
const text = (relative) => readFile(absolute(relative), 'utf8');
const json = async (relative) => JSON.parse(await text(relative));

const required = [
  'README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md',
  'docs/configuration.md', 'docs/data-handling.md', 'docs/efficient-dogfood.md', 'docs/release.md',
  'docs/future-work.md', 'docs/mcp-pending-call.md', 'docs/releases/v3.1.0.md',
  'docs/releases/v3.1.1.md', 'docs/releases/v3.2.0.md', 'docs/releases/v3.2.1.md',
  'docs/assets/codex-co-engineer-3.1.0.svg', 'docs/assets/codex-co-engineer-3.1.0.jpg',
  '.agents/plugins/marketplace.json', 'scripts/mcp-pending-call-probe.mjs',
  '.codex/release-gate.toml', '.github/workflows/ci.yml',
  `${PLUGIN}/.codex-plugin/plugin.json`, `${PLUGIN}/.mcp.json`, `${PLUGIN}/package.json`,
  `${PLUGIN}/README.md`, `${PLUGIN}/bin/setup.mjs`,
  `${PLUGIN}/mcp/v3/server.mjs`, `${PLUGIN}/mcp/v3/supervisor.mjs`,
  `${PLUGIN}/mcp/v3/task-store.mjs`, `${PLUGIN}/mcp/v3/acp-worker.mjs`,
  `${PLUGIN}/mcp/v3/contract.mjs`, `${PLUGIN}/mcp/v3/deadline.mjs`,
  `${PLUGIN}/mcp/v3/diagnostics.mjs`, `${PLUGIN}/mcp/v3/mailbox.mjs`,
  `${PLUGIN}/mcp/v3/cursor-cloud-worker.mjs`, `${PLUGIN}/mcp/v3/single-turn.flow.mjs`,
  `${PLUGIN}/mcp/v3/process-boundary.mjs`,
  `${PLUGIN}/mcp/v3/compact-task.mjs`, `${PLUGIN}/mcp/v3/provider-result.mjs`,
  `${PLUGIN}/mcp/v3/response.mjs`,
  `${PLUGIN}/assets/acpx-runtime.mjs`, `${PLUGIN}/assets/acpx-runtime.manifest.json`,
  `${PLUGIN}/assets/acpx-third-party-notices.md`,
  `${PLUGIN}/vendor/dsh-acp-demo/LICENSE`, `${PLUGIN}/vendor/dsh-acp-demo/PROVENANCE.json`,
  `${PLUGIN}/vendor/dsh-acp-demo/package.json`,
  `${PLUGIN}/skills/control-codex-co-engineer-agents/SKILL.md`,
  `${PLUGIN}/skills/control-codex-co-engineer-agents/agents/openai.yaml`,
  'scripts/release-prerequisites.mjs', 'scripts/validate-release.mjs', 'scripts/inspector-preflight.mjs',
  'scripts/process-boundary-preflight.mjs', 'scripts/mcp-environment-preflight.mjs',
  'tools/acpx-vendor/package.json', 'tools/acpx-vendor/package-lock.json',
];
for (const relative of required) {
  const entry = await lstat(absolute(relative)).catch((error) => fail(`Missing release file ${relative}: ${error.code ?? error.message}`));
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`Release file must be a regular non-symlink: ${relative}`);
}

if (Number.parseInt(process.versions.node.split('.', 1)[0], 10) !== 24) {
  fail(`Release validation requires Node major 24 (found ${process.versions.node}).`);
}

const manifest = await json(`${PLUGIN}/.codex-plugin/plugin.json`);
const packageJson = await json(`${PLUGIN}/package.json`);
const mcp = await json(`${PLUGIN}/.mcp.json`);
const serverText = await text(`${PLUGIN}/mcp/v3/server.mjs`);
if (manifest.name !== 'codex-co-engineer' || packageJson.name !== 'codex-co-engineer') {
  fail('Plugin manifest and package must use the codex-co-engineer identifier.');
}
const contractText = await text(`${PLUGIN}/mcp/v3/contract.mjs`);
if (manifest.version !== RELEASE_VERSION || packageJson.version !== RELEASE_VERSION
  || !contractText.includes(`VERSION = '${RELEASE_VERSION}'`)
  || !serverText.includes('version: VERSION')) {
  fail(`Plugin manifest, package, contract, and MCP server must all be version ${RELEASE_VERSION}.`);
}
if (manifest.interface?.displayName !== 'Codex-Co-Engineer') fail('Public display name mismatch.');
if (manifest.interface?.developerName !== 'Codex-Co-Engineer') fail('Public developer name mismatch.');
if (JSON.stringify(Object.keys(mcp.mcpServers ?? {})) !== JSON.stringify(['codex-co-engineer'])) {
  fail('MCP manifest must expose exactly the codex-co-engineer server key.');
}
const skillText = await text(`${PLUGIN}/skills/control-codex-co-engineer-agents/SKILL.md`);
if (!/^name: control-codex-co-engineer-agents$/mu.test(skillText)) {
  fail('Skill name must be the lowercase control-codex-co-engineer-agents identifier.');
}
const changelog = await text('CHANGELOG.md');
if (!changelog.includes(`## [${RELEASE_VERSION}]`)) fail(`CHANGELOG.md must record the ${RELEASE_VERSION} release.`);
const marketplace = await json('.agents/plugins/marketplace.json');
if (marketplace.plugins?.[0]?.version !== RELEASE_VERSION) fail(`Marketplace must catalog version ${RELEASE_VERSION}.`);
if (!skillText.includes('property named `repo`')
  || !skillText.includes('"repo": "/absolute/path/to/git-worktree"')
  || !skillText.includes('Do not rename `repo` to `git_root`')) {
  fail('Control skill must pin the literal delegate repo argument contract.');
}
if (!serverText.includes('Required property named repo')
  || !serverText.includes('Do not rename this property to git_root')
  || !serverText.includes('does not replace the required repo property')) {
  fail('MCP delegate schema must pin repo and distinguish Cursor Cloud starting_ref.');
}
if (packageJson.scripts?.test !== 'node --no-warnings --test test/*.test.mjs') fail('Unexpected test script.');
if (JSON.stringify(packageJson.files) !== JSON.stringify([
  '.codex-plugin', '.mcp.json', 'README.md', 'assets', 'bin', 'mcp', 'skills', 'vendor', 'package.json',
])) fail('Co-Engineer package roots changed.');

const server = mcp.mcpServers?.['codex-co-engineer'];
if (server?.command !== 'node'
  || JSON.stringify(server.args) !== JSON.stringify(['--no-warnings', './mcp/v3/server.mjs', '--stdio'])
  || server.tool_timeout_sec !== 14405) fail('MCP launch contract mismatch.');
for (const variable of [
  'HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'CODEX_CO_ENGINEER_STATE_DIR',
  'OPENROUTER_API_KEY', 'CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE',
  'CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG',
]) {
  if (!server.env_vars?.includes(variable)) fail(`MCP environment allowlist is missing ${variable}.`);
}

const toolNames = [...serverText.matchAll(/name: '([^']+)'/gu)].map((match) => match[1]).slice(0, 5);
if (JSON.stringify(toolNames) !== JSON.stringify(['status', 'delegate', 'task', 'tasks', 'cancel'])) {
  fail('MCP tool catalog must contain exactly status, delegate, task, tasks, cancel.');
}
if (!serverText.includes('wait_ms') || !serverText.includes('event_cursor') || !serverText.includes("pattern: '^[0-9]{1,16}$'")) {
  fail('task tool must advertise bounded wait_ms/cursor live progress.');
}
if (!serverText.includes('wait_until') || !serverText.includes('expected_duration_ms') || !serverText.includes('diagnostics')) {
  fail('task/delegate must advertise durable terminal waits, expected duration, and diagnostics.');
}
if (!serverText.includes('dsh_model') || !serverText.includes('stealth/ox-alpha')) {
  fail('3.2.1 public contract must advertise the optional Ox Alpha DSH model selector.');
}
if (!serverText.includes('response_mode')
  || !serverText.includes("enum: ['structured']")
  || !serverText.includes("enum: ['summary', 'diagnostics', 'compact']")
  || !serverText.includes('task_ids')
  || !serverText.includes('cursors')) {
  fail('3.2 public contract must advertise structured response_mode, compact task view, and wait-any task_ids/cursors.');
}
const compactTaskText = await text(`${PLUGIN}/mcp/v3/compact-task.mjs`);
if (!compactTaskText.includes('WAIT_ANY_RESPONSE_STRUCTURED_BYTES_MAX')
  || !compactTaskText.includes('projectWaitAnyProgress')
  || !compactTaskText.includes('enforceWaitAnyResponseBudget')) {
  fail('compact-task.mjs must export the bounded wait-any projection contract.');
}
const taskStoreText = await text(`${PLUGIN}/mcp/v3/task-store.mjs`);
if (!taskStoreText.includes('waitAnyResult') || !taskStoreText.includes('waitAnyCandidate')) {
  fail('task-store.mjs must retain wait-any runtime coordination.');
}
const configurationText = await text('docs/configuration.md');
if (!configurationText.includes('view: "compact"')
  || !configurationText.includes('detail: "compact"')
  || !configurationText.includes('task_ids')
  || !configurationText.includes('response_mode: "structured"')
  || !configurationText.includes('efficient-dogfood.md')) {
  fail('Configuration guide must document the 3.2 compact, wait-any, structured transport, and dogfood workflow contracts.');
}
const maximumTaskId = 'a'.repeat(80);
if (compactTaskCard({ id: maximumTaskId, status: 'running' }).id !== maximumTaskId) {
  fail('Compact list cards must preserve the complete 80-character task ID coordination key.');
}
const mcpEntries = await readdir(absolute(`${PLUGIN}/mcp`));
if (JSON.stringify(mcpEntries) !== JSON.stringify(['v3'])) fail('Legacy MCP modules remain packaged.');

const runtimeManifest = await json(`${PLUGIN}/assets/acpx-runtime.manifest.json`);
const runtime = await readFile(absolute(`${PLUGIN}/assets/acpx-runtime.mjs`));
const sha512 = (value) => `sha512-${createHash('sha512').update(value).digest('base64')}`;
if (runtimeManifest.source?.version !== '0.13.0' || sha512(runtime) !== runtimeManifest.bundle_sha512) {
  fail('Pinned ACPX runtime provenance/hash mismatch.');
}
const lock = await readFile(absolute('tools/acpx-vendor/package-lock.json'));
if (sha512(lock) !== runtimeManifest.dependencies?.lock_sha512) fail('Pinned ACPX lock hash mismatch.');

const provenance = await json(`${PLUGIN}/vendor/dsh-acp-demo/PROVENANCE.json`);
if (provenance.package !== '@deepseek-ai/dsh-acp-demo@0.1.0-rc.7' || provenance.license !== 'MIT') {
  fail('DSH rc.7 provenance mismatch.');
}
const treeHash = createHash('sha256');
for (const relative of [...provenance.vendored_tree_files].sort()) {
  treeHash.update(relative); treeHash.update('\0');
  treeHash.update(await readFile(absolute(`${PLUGIN}/vendor/dsh-acp-demo/${relative}`))); treeHash.update('\0');
}
if (treeHash.digest('hex') !== provenance.vendored_tree_sha256) fail('Vendored DSH tree hash mismatch.');
const dshPackage = await json(`${PLUGIN}/vendor/dsh-acp-demo/package.json`);
for (const file of ['LICENSE', 'PROVENANCE.json']) {
  if (!dshPackage.files?.includes(file)) fail(`DSH package omits ${file}.`);
}

async function releaseFiles(directory = ROOT) {
  const values = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.worktrees') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) values.push(...await releaseFiles(target));
    else if (entry.isFile()) values.push(path.relative(ROOT, target));
  }
  return values;
}
const tracked = await releaseFiles();
const sha256Text = (value) => createHash('sha256').update(value.toLowerCase()).digest('hex');
// Keep the historical identity deny-list without putting the identity back in
// the public source. Candidate extraction below is deliberately generic.
const forbiddenIdentityFingerprints = new Map([
  [16, new Set(['6383cd2ce525e2de7f0abdfde3c91410b5e56071e67da7da4b0743269d097b89'])],
  [10, new Set(['a8b328b65bbcc9fcc4b8158e67b1ba3db0a10dec275b18861ff396c911841998'])],
]);
const emailPattern = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const namePattern = /\b[A-Za-z][A-Za-z'-]*\s+[A-Za-z][A-Za-z'-]*\b/gu;
const localPathPattern = /(?:^|[\s"'`=(])\/(?:home|mnt|Users)\/(?!test-user(?:\W|$))[A-Za-z0-9._-]+(?:[\/\s][A-Za-z0-9._-]+)*/iu;
const credentialPatterns = [
  /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/iu,
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/iu,
];

function hasForbiddenIdentity(source) {
  for (const pattern of [emailPattern, namePattern]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const candidate = match[0];
      if (pattern === emailPattern && /@(?:example\.(?:com|net|org|test)|invalid)$/iu.test(candidate)) continue;
      if (forbiddenIdentityFingerprints.get(candidate.length)?.has(sha256Text(candidate))) return true;
    }
  }
  return false;
}

for (const relative of tracked) {
  const value = await readFile(absolute(relative)).catch(() => null);
  if (!value || value.includes(0)) continue;
  const source = value.toString('utf8');
  if (hasForbiddenIdentity(source) || localPathPattern.test(source)) {
    fail(`Personal/local data found in tracked file ${relative}.`);
  }
  const isFixture = /(?:^|\/)test(?:\/|$)/u.test(relative) || /\.test\.[^/]+$/u.test(relative);
  if (!isFixture && credentialPatterns.some((pattern) => pattern.test(source))) {
    fail(`Credential material found in tracked file ${relative}.`);
  }
}

for (const obsolete of [
  `${PLUGIN}/mcp/control.mjs`, `${PLUGIN}/mcp/server.mjs`,
  `${PLUGIN}/assets/dsh-headless.patch.yml`, 'scripts/target-fingerprint.mjs',
  'config/configuration.schema.json', 'examples/target-context.json',
]) {
  try { await lstat(absolute(obsolete)); fail(`Obsolete release file remains: ${obsolete}`); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const forbiddenLegacy = [
  ['plumbob', '-', 'harness', '-', 'control'].join(''),
  ['plumbob', '_', 'harness', '_', 'control'].join(''),
  ['plumbob', '-', 'acpx'].join(''),
  ['control', '-', 'plumbob', '-', 'agents'].join(''),
  ['PLUMBOB', '_', 'HARNESS'].join(''),
];
for (const relative of tracked) {
  const value = await readFile(absolute(relative)).catch(() => null);
  if (!value || value.includes(0)) continue;
  const source = value.toString('utf8');
  if (forbiddenLegacy.some((token) => source.toLowerCase().includes(token.toLowerCase()))) {
    fail(`Legacy product identifier remains in ${relative}.`);
  }
}

process.stdout.write(`Codex-Co-Engineer ${RELEASE_VERSION} release validation passed.\n`);
