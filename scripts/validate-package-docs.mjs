#!/usr/bin/env node

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keep this list deliberately small. The 3.3.0 note is included only because
// the migration guide links to it; it is not an invitation to package the
// repository's internal docs tree.
export const PACKAGE_DOCUMENTS = Object.freeze([
  ['docs/co-engineer-quickstart.md', 'co-engineer-quickstart.md'],
  ['docs/co-engineer-troubleshooting.md', 'co-engineer-troubleshooting.md'],
  ['docs/co-engineer-migration-3.2.1.md', 'co-engineer-migration-3.2.1.md'],
  ['docs/configuration.md', 'configuration.md'],
  ['docs/mcp-pending-call.md', 'mcp-pending-call.md'],
  ['docs/run-tool-api.md', 'run-tool-api.md'],
  ['docs/run-results.md', 'run-results.md'],
  ['docs/efficient-dogfood.md', 'efficient-dogfood.md'],
  ['docs/releases/v3.3.0.md', 'releases/v3.3.0.md'],
  ['docs/releases/v3.4.1.md', 'releases/v3.4.1.md'],
  ['docs/releases/v3.4.2.md', 'releases/v3.4.2.md'],
  ['docs/releases/v3.4.3.md', 'releases/v3.4.3.md'],
].map(([source, packageRelative]) => Object.freeze({ source, packageRelative })));

export const PACKAGE_DOC_ROOT = 'plugins/codex-co-engineer/docs';

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

async function regularFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await regularFiles(target, relative));
    } else if (entry.isFile()) {
      files.push(relative.split(path.sep).join('/'));
    } else {
      throw new Error(`Package documentation contains a non-regular entry: ${relative}`);
    }
  }
  return files.sort();
}

export async function syncPackageDocs(root = ROOT) {
  for (const { source, packageRelative } of PACKAGE_DOCUMENTS) {
    const sourcePath = path.join(root, source);
    const packagePath = path.join(root, PACKAGE_DOC_ROOT, packageRelative);
    await mkdir(path.dirname(packagePath), { recursive: true });
    await writeFile(packagePath, await readFile(sourcePath));
  }
}

export async function validatePackageDocs(root = ROOT) {
  const expected = new Set(PACKAGE_DOCUMENTS.map(({ packageRelative }) => packageRelative));
  const packageRoot = path.join(root, PACKAGE_DOC_ROOT);
  await access(packageRoot);

  for (const { source, packageRelative } of PACKAGE_DOCUMENTS) {
    const sourcePath = path.join(root, source);
    const packagePath = path.join(packageRoot, packageRelative);
    const [sourceBytes, packageBytes] = await Promise.all([
      readFile(sourcePath),
      readFile(packagePath),
    ]);
    if (!sameBytes(sourceBytes, packageBytes)) {
      throw new Error(`Packaged documentation differs from its source: ${packageRelative}`);
    }
  }

  const actual = await regularFiles(packageRoot);
  const extras = actual.filter((file) => !expected.has(file));
  const missing = [...expected].filter((file) => !actual.includes(file));
  if (extras.length > 0) {
    throw new Error(`Unallowlisted package documentation: ${extras.join(', ')}`);
  }
  if (missing.length > 0) {
    throw new Error(`Missing package documentation: ${missing.join(', ')}`);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    if (process.argv.includes('--sync')) await syncPackageDocs();
    await validatePackageDocs();
    process.stdout.write(`Package documentation validation passed (${PACKAGE_DOCUMENTS.length} files).\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
