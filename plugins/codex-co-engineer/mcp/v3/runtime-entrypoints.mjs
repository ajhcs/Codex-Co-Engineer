import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ENTRYPOINTS = Object.freeze({
  local: Object.freeze([
    fileURLToPath(new URL('./acp-worker.mjs', import.meta.url)),
    fileURLToPath(new URL('./credential-handoff-loader.mjs', import.meta.url)),
  ]),
  cloud: Object.freeze([
    fileURLToPath(new URL('./cursor-cloud-worker.mjs', import.meta.url)),
  ]),
});

async function inspectReadableFile(file) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw Object.assign(new Error('Runtime entrypoint is not a regular file.'), { code: 'EINVAL' });
  await access(file, constants.R_OK);
}

export async function assertRuntimeEntrypoints(provider, { inspectFile = inspectReadableFile } = {}) {
  const entrypoints = provider === 'cursor-cloud' ? ENTRYPOINTS.cloud : ENTRYPOINTS.local;
  try {
    await Promise.all(entrypoints.map((entrypoint) => inspectFile(entrypoint)));
  } catch {
    throw Object.assign(
      new Error('The installed Codex-Co-Engineer runtime is incomplete.'),
      { code: 'runtime_install_incomplete' },
    );
  }
}
