#!/usr/bin/env node

import {
  access,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PROBE_TIMEOUT_MS = 3_000;
const PROBE_OUTPUT_BYTES = 16 * 1024;
const REQUIRED_BWRAP_FLAGS = [
  '--unshare-all', '--unshare-user', '--share-net', '--disable-userns', '--assert-userns-disabled',
  '--tmpfs', '--ro-bind-fd', '--bind-fd', '--remount-ro',
];
const EXPECTED_INSPECTOR_PACKAGE = '@modelcontextprotocol/inspector';
const EXPECTED_INSPECTOR_VERSION = '2.2.0';

function blocked(code, message) {
  const error = new Error(`[${code}] ${message}`);
  error.code = code;
  throw error;
}

function requireLinux() {
  if (process.platform !== 'linux') blocked('LINUX_REQUIRED', 'the strict outer test requires Linux');
  const major = Number.parseInt(process.versions.node.split('.', 1)[0], 10);
  if (major !== 24) blocked('NODE_MAJOR_UNSUPPORTED', `Node major 24 is required (found ${process.versions.node})`);
}

async function findBubblewrap() {
  const pathValue = process.env.PATH ?? '';
  const candidates = [
    process.env.CODEX_TEST_BWRAP_PATH,
    ...pathValue.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'bwrap')),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await lstat(candidate);
      const canonical = await realpath(candidate);
      const canonicalEntry = await lstat(canonical);
      if (!canonicalEntry.isFile() || (canonicalEntry.mode & 0o111) === 0) continue;
      const versionProbe = spawnSync(canonical, ['--version'], {
        cwd: os.tmpdir(),
        env: { PATH: pathValue, LC_ALL: 'C', LANG: 'C' },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_OUTPUT_BYTES,
        shell: false,
      });
      const helpProbe = spawnSync(canonical, ['--help'], {
        cwd: os.tmpdir(),
        env: { PATH: pathValue, LC_ALL: 'C', LANG: 'C' },
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: PROBE_OUTPUT_BYTES,
        shell: false,
      });
      const version = `${versionProbe.stdout ?? ''}\n${versionProbe.stderr ?? ''}`;
      const help = `${helpProbe.stdout ?? ''}\n${helpProbe.stderr ?? ''}`;
      if (versionProbe.status === 0 && helpProbe.status === 0 && /bubblewrap/iu.test(version)
        && REQUIRED_BWRAP_FLAGS.every((flag) => help.includes(flag))) return canonical;
    } catch {
      // Continue through PATH; the final error is stable and bounded.
    }
  }
  blocked('BUBBLEWRAP_UNAVAILABLE', 'a compatible executable bubblewrap was not found on PATH');
}

async function findBusybox() {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of ['busybox', 'busybox-static']) {
      const candidate = path.join(directory, name);
      try {
        await lstat(candidate);
        const canonical = await realpath(candidate);
        const entry = await lstat(canonical);
        if (entry.isFile() && (entry.mode & 0o111) !== 0) return canonical;
      } catch {
        // Continue through PATH; the final error is stable and bounded.
      }
    }
  }
  blocked('BUSYBOX_UNAVAILABLE', 'a static BusyBox executable was not found on PATH');
}

async function requirePinnedInspector() {
  const command = process.env.MCP_INSPECTOR_COMMAND ?? 'mcp-inspector';
  if (path.basename(command) !== command || command.includes(path.sep)) {
    blocked('INSPECTOR_UNAVAILABLE', 'MCP_INSPECTOR_COMMAND must name a PATH executable');
  }
  const pathValue = process.env.PATH ?? '';
  let executable;
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await lstat(candidate);
      const canonical = await realpath(candidate);
      const entry = await lstat(canonical);
      if (entry.isFile() && (entry.mode & 0o111) !== 0) {
        executable = canonical;
        break;
      }
    } catch {
      // Continue through PATH; the final error is stable and bounded.
    }
  }
  if (!executable) blocked('INSPECTOR_UNAVAILABLE', `${command} was not found on PATH`);

  // Inspect package metadata instead of spawning Inspector. Inspector starts
  // a server/client process and is intentionally left to its dedicated gate
  // stage, where its output is captured and classified.
  let directory = path.dirname(executable);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (packageJson.name === EXPECTED_INSPECTOR_PACKAGE) {
        if (packageJson.version !== EXPECTED_INSPECTOR_VERSION) {
          blocked('INSPECTOR_VERSION_UNSUPPORTED', `${EXPECTED_INSPECTOR_PACKAGE}@${EXPECTED_INSPECTOR_VERSION} is required`);
        }
        return packageJson.version;
      }
    } catch (error) {
      if (error?.code?.startsWith?.('INSPECTOR_')) throw error;
      // Walk toward the package root; a launcher may live several directories deep.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  blocked('INSPECTOR_VERSION_UNSUPPORTED', `could not attest ${EXPECTED_INSPECTOR_PACKAGE}@${EXPECTED_INSPECTOR_VERSION} without starting Inspector`);
}

async function runProviderFreeBoundaryProbe(bwrap, busybox) {
  const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-release-bwrap-'));
  const marker = path.join(probeRoot, 'boundary-marker');
  const handles = [];
  try {
    handles.push(await open(bwrap, 'r'));
    handles.push(await open(busybox, 'r'));
    handles.push(await open(probeRoot, 'r'));
    const [bwrapHandle, busyboxHandle, workspaceHandle] = handles;
    const boundarySource = [
      'set -eu',
      'test -x /usr/bin/busybox',
      'test -r /proc/self/status',
      'test ! -e /etc/passwd',
      'if touch /release-root-marker 2>/dev/null; then exit 20; fi',
      'printf boundary-ok > /workspace/boundary-marker',
    ].join('; ');
    const result = spawnSync(`/proc/self/fd/${bwrapHandle.fd}`, [
      '--die-with-parent',
      '--unshare-all',
      // Match the production outer boundary: network sharing is explicit and
      // this provider-free probe never opens a socket or invokes a provider.
      '--unshare-user',
      '--share-net',
      '--disable-userns',
      '--assert-userns-disabled',
      '--new-session',
      '--clearenv',
      '--tmpfs', '/',
      '--dir', '/proc',
      '--dir', '/dev',
      '--dir', '/usr',
      '--dir', '/usr/bin',
      '--dir', '/workspace',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--tmpfs', '/var/tmp',
      '--tmpfs', '/run',
      '--ro-bind-fd', '4', '/usr/bin/busybox',
      '--bind-fd', '5', '/workspace',
      '--remount-ro', '/',
      '--setenv', 'PATH', '/usr/bin',
      '--setenv', 'LANG', 'C',
      '--setenv', 'LC_ALL', 'C',
      '--', '/usr/bin/busybox', 'sh', '-c', boundarySource,
    ], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', LANG: 'C' },
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_OUTPUT_BYTES,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe', bwrapHandle.fd, busyboxHandle.fd, workspaceHandle.fd],
    });
    if (result.error || result.status !== 0) {
      blocked('OUTER_BOUNDARY_UNUSABLE', 'production-shaped Bubblewrap boundary probe failed');
    }
    if ((await readFile(marker, 'utf8').catch(() => '')) !== 'boundary-ok') {
      blocked('OUTER_BOUNDARY_UNUSABLE', 'inherited writable fd mount did not remain available inside the boundary');
    }
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
    await rm(probeRoot, { recursive: true, force: true });
  }
}

requireLinux();
const inspectorVersion = await requirePinnedInspector();
const bwrap = await findBubblewrap();
const busybox = await findBusybox();
await access(bwrap);
await runProviderFreeBoundaryProbe(bwrap, busybox);
process.stdout.write(`release prerequisites passed (Node ${process.versions.node}, ${EXPECTED_INSPECTOR_PACKAGE}@${inspectorVersion}, ${path.basename(bwrap)}, static BusyBox fd boundary)\n`);
