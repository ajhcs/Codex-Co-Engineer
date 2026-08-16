#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DSH = process.env.CODEX_CO_ENGINEER_DSH_COMMAND ?? 'dsh';
const templateFile = process.env.DSH_PATCH_TEMPLATE;
const targetWorkspace = process.env.DSH_TARGET_WORKSPACE;
const patchFile = process.env.DSH_TARGET_PATCH_FILE;

function yamlString(value) {
  // JSON double-quoted strings are valid YAML scalars and safely encode paths
  // containing spaces, quotes, or other YAML-significant characters.
  return JSON.stringify(value);
}

export function targetPatch(template, workspace) {
  const lines = template.split(/\r?\n/);
  const workspaceFlag = lines.findIndex((line) => line.trim() === '- --workspace');
  if (workspaceFlag < 0 || !lines[workspaceFlag + 1]) {
    throw new Error('DeepSeek patch template has no target workspace argument.');
  }
  const valueLine = lines[workspaceFlag + 1];
  const indentation = valueLine.match(/^\s*/)?.[0] ?? '';
  lines[workspaceFlag + 1] = `${indentation}${yamlString(workspace)}`;

  const cwdLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s+cwd:\s+/.test(line));
  if (cwdLines.length !== 1) {
    throw new Error('DeepSeek patch template must contain exactly one MCP cwd.');
  }
  const { line, index } = cwdLines[0];
  const cwdIndentation = line.match(/^\s*/)?.[0] ?? '';
  lines[index] = `${cwdIndentation}cwd: ${yamlString(workspace)}`;
  return lines.join('\n');
}

async function main() {
  if (!templateFile || !targetWorkspace || !patchFile) {
    throw new Error('Target-aware DeepSeek launch requires a patch template, workspace, and patch file.');
  }
  const template = await readFile(templateFile, 'utf8');
  await writeFile(patchFile, targetPatch(template, targetWorkspace), { mode: 0o600 });
  try {
    const child = spawn(DSH, ['--patch', patchFile, ...process.argv.slice(2)], {
      // The runner has already established the requested working directory;
      // keep it for the model process while the MCP backend is rooted at the
      // enclosing Git checkout above.
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
      },
      stdio: 'inherit',
    });
    const result = await new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (result.error) throw result.error;
    process.exitCode = result.code ?? 1;
  } finally {
    await unlink(patchFile).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`DeepSeek target launch failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
