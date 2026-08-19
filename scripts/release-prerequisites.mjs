#!/usr/bin/env node

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const EXPECTED_NAME = '@modelcontextprotocol/inspector';
const EXPECTED_VERSION = '2.2.0';

function fail(code, message) {
  throw Object.assign(new Error(`[${code}] ${message}`), { code });
}

const nodeMajor = Number.parseInt(process.versions.node.split('.', 1)[0], 10);
if (nodeMajor !== 24) fail('NODE_MAJOR_UNSUPPORTED', `Node major 24 is required (found ${process.versions.node}).`);

const command = process.env.MCP_INSPECTOR_COMMAND ?? 'mcp-inspector';
if (path.basename(command) !== command) fail('INSPECTOR_UNAVAILABLE', 'MCP_INSPECTOR_COMMAND must name a PATH executable.');
let executable;
for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
  try {
    const candidate = await realpath(path.join(directory, command));
    const metadata = await lstat(candidate);
    if (metadata.isFile() && (metadata.mode & 0o111) !== 0) { executable = candidate; break; }
  } catch {
    // Keep searching PATH.
  }
}
if (!executable) fail('INSPECTOR_UNAVAILABLE', `${command} was not found on PATH.`);

let directory = path.dirname(executable);
let version;
for (let depth = 0; depth < 12; depth += 1) {
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (metadata.name === EXPECTED_NAME) { version = metadata.version; break; }
  } catch {
    // Walk toward the package root.
  }
  const parent = path.dirname(directory);
  if (parent === directory) break;
  directory = parent;
}
if (version !== EXPECTED_VERSION) fail('INSPECTOR_VERSION_UNSUPPORTED', `${EXPECTED_NAME}@${EXPECTED_VERSION} is required.`);

process.stdout.write(`release prerequisites passed (Node ${process.versions.node}, ${EXPECTED_NAME}@${version})\n`);
