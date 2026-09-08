import { fileURLToPath } from 'node:url';

export const BUNDLED_WORKTREE_BOOTSTRAP = fileURLToPath(
  new URL('../../vendor/worktree-bootstrap/worktree-bootstrap', import.meta.url),
);
