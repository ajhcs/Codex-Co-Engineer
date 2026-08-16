#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_IDENTITY } from '../plugins/plumbob-harness-control/mcp/preflight.mjs';
import { SERVER_IDENTITY as CURSOR_SERVER_IDENTITY } from '../plugins/cursor-cloud-control/mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  '.github/workflows/ci.yml', '.gitignore', 'CHANGELOG.md', 'CONTRIBUTING.md',
  'LICENSE', 'README.md', 'SECURITY.md', 'config/configuration.example.json',
  'config/configuration.schema.json',
  'docs/configuration.md', 'docs/data-handling.md', 'docs/preflight-inspector.md',
  'docs/release.md', 'docs/target-contract.md',
  'plugins/plumbob-harness-control/.codex-plugin/plugin.json',
  'plugins/plumbob-harness-control/.mcp.json',
  'plugins/cursor-cloud-control/.codex-plugin/plugin.json',
  'plugins/cursor-cloud-control/.mcp.json',
  'plugins/cursor-cloud-control/package.json',
  'plugins/cursor-cloud-control/README.md',
  'plugins/cursor-cloud-control/mcp/server.mjs',
  'plugins/cursor-cloud-control/skills/control-cursor-cloud-agents/SKILL.md',
  'scripts/inspector-preflight.mjs', 'scripts/cursor-inspector-preflight.mjs', 'scripts/target-fingerprint.mjs',
];
for (const relative of required) await access(path.join(ROOT, relative));

const manifest = JSON.parse(await readFile(path.join(ROOT, 'plugins/plumbob-harness-control/.codex-plugin/plugin.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(ROOT, 'plugins/plumbob-harness-control/package.json'), 'utf8'));
const configurationSchema = JSON.parse(await readFile(path.join(ROOT, 'config/configuration.schema.json'), 'utf8'));
const configurationExample = JSON.parse(await readFile(path.join(ROOT, 'config/configuration.example.json'), 'utf8'));
const cursorManifest = JSON.parse(await readFile(path.join(ROOT, 'plugins/cursor-cloud-control/.codex-plugin/plugin.json'), 'utf8'));
const cursorPackage = JSON.parse(await readFile(path.join(ROOT, 'plugins/cursor-cloud-control/package.json'), 'utf8'));
if (manifest.version !== packageJson.version || packageJson.version !== SERVER_IDENTITY.version) {
  throw new Error('Manifest, package, and MCP server versions must match.');
}
if (manifest.interface.displayName !== 'Codex-Co-Engineer') throw new Error('Public display name mismatch.');
if (cursorManifest.version !== cursorPackage.version || cursorPackage.version !== CURSOR_SERVER_IDENTITY.version) {
  throw new Error('Cursor manifest, package, and MCP server versions must match.');
}
if (cursorManifest.interface.displayName !== 'Cursor Cloud Control') throw new Error('Cursor public display name mismatch.');
for (const section of ['transport', 'runtime', 'credentials', 'target', 'deadlines']) {
  if (configurationSchema.properties?.[section]?.additionalProperties !== false) {
    throw new Error(`Configuration schema section ${section} must reject unknown fields.`);
  }
  if (configurationExample[section] === null || typeof configurationExample[section] !== 'object') {
    throw new Error(`Configuration example is missing section ${section}.`);
  }
}
if (configurationSchema.additionalProperties !== false) {
  throw new Error('Configuration schema must reject unknown top-level fields.');
}
if (configurationExample.schema_version !== 'codex-co-engineer.config.v1'
  || configurationExample.target?.schema_version !== 'codex-co-engineer.target.v1'
  || configurationExample.target?.mode !== 'explicit') {
  throw new Error('Configuration example must use the strict v1 explicit-target contract.');
}

const skipped = new Set(['.git', '.serena', 'Secrets', 'prime-intellect-lab', 'node_modules', 'research']);
const forbidden = [
  /\/home\/plumbob\b/g,
  /\/mnt\/d\/Coding Projects\/CheapTesting/g,
  new RegExp(['muse', 'spark', 'api', 'key'].join('-'), 'g'),
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
];
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile() && (await stat(absolute)).size <= 2_000_000) files.push(absolute);
  }
  return files;
}
for (const file of await walk(ROOT)) {
  if (/\.(?:png|ico|jpg|jpeg|gif)$/i.test(file)) continue;
  const text = await readFile(file, 'utf8');
  for (const pattern of forbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) throw new Error(`Forbidden private material pattern in ${path.relative(ROOT, file)}.`);
  }
}
process.stdout.write(`release validation passed (${required.length} required files, version ${packageJson.version})\n`);
