// Shared construction helpers for P29 credential-boundary tests.
// Tests own the assertions. Fixtures never print credential values.

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_DSH_MODEL, DSH_OX_MODEL } from '../../mcp/v3/credential-boundary.mjs';

export const HOSTILE_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/test-user',
  USER: 'test-user',
  GIT_SSH: '/tmp/hostile-ssh',
  GIT_SSH_COMMAND: 'ssh -i /tmp/hostile-id',
  GIT_ASKPASS: '/tmp/hostile-askpass',
  GIT_CONFIG_PARAMETERS: "'credential.helper=store'",
  SSH_AUTH_SOCK: '/tmp/hostile-agent.sock',
  SSH_AGENT_PID: '4242',
  GH_TOKEN: 'ghp_hostile-github-token-value',
  GITHUB_TOKEN: 'github_pat_hostile-value',
  GITLAB_TOKEN: 'glpat-hostile-value',
  BITBUCKET_TOKEN: 'bbat-hostile-value',
  WORKTREE_BOOTSTRAP_TASK: 'hostile-control-token',
  CODEX_CO_ENGINEER_MODEL_API_KEY_FILE: '/tmp/hostile-muse-key',
  CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE: '/tmp/hostile-ox-key',
  CURSOR_API_KEY_FILE: '/tmp/hostile-cursor-key',
  MODEL_API_KEY: 'muse-secret-value-abcdef',
  OPENROUTER_API_KEY: 'ox-secret-value-abcdef',
  XAI_API_KEY: 'xai-secret-value-abcdef',
  CURSOR_API_KEY: 'cursor-secret-value-abcdef',
  NODE_OPTIONS: '--require /tmp/hostile-preload',
});

export const CONTENT_FREE = /^[A-Za-z0-9_=.:/\[\]()";', -]+$/u;

export { DEFAULT_DSH_MODEL, DSH_OX_MODEL };

export async function withTempDir(prefix, build) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await build(root);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeOwnerFile(file, contents, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode, flag: 'wx' });
  await chmod(file, mode);
  return file;
}
