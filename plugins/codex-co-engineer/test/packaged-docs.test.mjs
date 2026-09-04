import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PACKAGE_DOCUMENTS } from '../../../scripts/validate-package-docs.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const NPM = process.env.npm_execpath || 'npm';

function slashPath(value) {
  return value.split(path.sep).join('/');
}

async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(target, relative));
    } else {
      assert.equal(entry.isFile(), true, `archive contains a non-file entry: ${relative}`);
      files.push(slashPath(relative));
    }
  }
  return files.sort();
}

function decode(value, label) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    assert.fail(`${label} contains an invalid percent escape: ${error.message}`);
  }
}

function stripMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .replace(/<[^>]*>/gu, '');
}

function githubHeadingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  for (const match of markdown.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)) {
    const heading = stripMarkdown(match[1])
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/[\s]+/gu, '-');
    if (!heading) continue;
    const count = counts.get(heading) || 0;
    counts.set(heading, count + 1);
    anchors.add(count === 0 ? heading : `${heading}-${count}`);
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/giu)) {
    anchors.add(match[1]);
  }
  return anchors;
}

function markdownLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|([^\s)\n]+))/gu;
  for (const match of markdown.matchAll(pattern)) {
    links.push(match[1] ?? match[2]);
  }
  return links;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertMarkdownLinks(root) {
  const documentation = (await listFiles(root)).filter((file) => file.endsWith('.md'));
  for (const relative of documentation) {
    const markdownPath = path.join(root, relative);
    const markdown = await readFile(markdownPath, 'utf8');
    for (const target of markdownLinks(markdown)) {
      if (/^https?:\/\//iu.test(target) || /^mailto:/iu.test(target)) continue;
      assert.equal(/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target), false, `${relative}: unsupported URL ${target}`);
      assert.equal(target.startsWith('//'), false, `${relative}: protocol-relative URL ${target}`);

      const hash = target.indexOf('#');
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? undefined : target.slice(hash + 1);
      const targetPath = decode(rawPath, `${relative}: ${target}`);
      assert.equal(targetPath.startsWith('/'), false, `${relative}: absolute path ${target}`);
      const resolved = path.resolve(path.dirname(markdownPath), targetPath || path.basename(markdownPath));
      assert.equal(isWithin(root, resolved), true, `${relative}: link escapes package root: ${target}`);
      const targetStat = await stat(resolved).catch((error) => {
        assert.fail(`${relative}: missing link target ${target}: ${error.message}`);
      });
      assert.equal(targetStat.isFile(), true, `${relative}: link target is not a file: ${target}`);

      if (fragment !== undefined) {
        const anchor = decode(fragment, `${relative}: ${target}`);
        assert.notEqual(anchor, '', `${relative}: empty anchor in ${target}`);
        const targetMarkdown = await readFile(resolved, 'utf8');
        assert.equal(
          githubHeadingAnchors(targetMarkdown).has(anchor),
          true,
          `${relative}: invalid anchor in ${target}`,
        );
      }
    }
  }
}

async function assertPackageDocs(root, { compareSource = false } = {}) {
  const allFiles = await listFiles(root);
  for (const file of allFiles) {
    assert.doesNotMatch(
      file,
      /(?:^|\/)(?:\.git|node_modules|tests?|receipts?|private-receipts?|machine-specific|desktopqualification)(?:\/|$)/iu,
      `archive contains an unapproved private or machine-specific file: ${file}`,
    );
  }
  const expected = PACKAGE_DOCUMENTS.map(({ packageRelative }) => `docs/${packageRelative}`).sort();
  const actual = allFiles.filter((file) => file === 'README.md' || file.startsWith('docs/'));
  assert.deepEqual(actual, ['README.md', ...expected].sort(), 'README/docs inventory is not allowlisted');

  for (const file of actual.filter((entry) => entry.startsWith('docs/'))) {
    assert.doesNotMatch(
      file,
      /(?:receipt|private|machine|host|desktopqualification|(?:^|\/)\.codex|(?:^|\/)(?:tmp|home|mnt|users)(?:\/|$))/iu,
      `unapproved private or machine-specific documentation: ${file}`,
    );
  }

  if (compareSource) {
    for (const { source, packageRelative } of PACKAGE_DOCUMENTS) {
      const sourceBytes = await readFile(path.join(REPO, source));
      const packageBytes = await readFile(path.join(root, 'docs', packageRelative));
      assert.deepEqual(packageBytes, sourceBytes, `packaged documentation drifted: ${packageRelative}`);
    }
  }
}

test('packed documentation is self-contained and installs without the source repository', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'cce-packaged-docs-'));
  const packDirectory = path.join(scratch, 'pack');
  const extractDirectory = path.join(scratch, 'extract');
  const installDirectory = path.join(scratch, 'install');
  const npmCache = path.join(scratch, 'npm-cache');
  await Promise.all([
    mkdir(packDirectory),
    mkdir(extractDirectory),
    mkdir(installDirectory),
    mkdir(npmCache),
  ]);
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
  };

  try {
    await execFileAsync(NPM, [
      'pack', '.',
      '--pack-destination', packDirectory,
      '--ignore-scripts',
      '--offline',
      '--json',
    ], { cwd: ROOT, env: npmEnvironment, maxBuffer: 4 * 1024 * 1024 });

    const archives = (await readdir(packDirectory)).filter((entry) => entry.endsWith('.tgz'));
    assert.equal(archives.length, 1, 'npm pack did not produce exactly one archive');
    const archive = path.join(packDirectory, archives[0]);

    await execFileAsync('tar', ['-xzf', archive, '-C', extractDirectory], { maxBuffer: 4 * 1024 * 1024 });
    const packedRoot = path.join(extractDirectory, 'package');
    await access(path.join(packedRoot, 'README.md'));
    await assertPackageDocs(packedRoot, { compareSource: true });
    await assertMarkdownLinks(packedRoot);

    await execFileAsync(NPM, [
      'install',
      '--prefix', installDirectory,
      '--no-save',
      '--no-package-lock',
      '--ignore-scripts',
      '--offline',
      archive,
    ], { cwd: installDirectory, env: npmEnvironment, maxBuffer: 4 * 1024 * 1024 });
    const installedRoot = path.join(installDirectory, 'node_modules', 'codex-co-engineer');
    await access(path.join(installedRoot, 'README.md'));
    await assertPackageDocs(installedRoot);
    await assertMarkdownLinks(installedRoot);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
