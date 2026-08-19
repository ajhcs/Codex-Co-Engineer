# Data handling

Codex-Co-Engineer starts trusted peer coding agents. Selecting Grok, Cursor
Local, Cursor Cloud, or DSH authorizes that provider to receive the task
prompt and the repository material needed for the task. Providers may run
shell commands, install dependencies, and modify their assigned workspace or
remote branch. Do not delegate a repository or prompt that the selected
provider is not authorized to process.

## Workspace boundary

Local tasks use ACP first and a same-provider CLI fallback only when ACP fails
before prompt dispatch. DSH ACPX has no authoritative prompt-sent
acknowledgement, so it becomes `dispatch_uncertain` after spawn and is never
replayed through CLI. Managed local tasks use one
`worktree-bootstrap` worktree and branch per task. Direct mode is an explicit
opt-in and permits mutation of the caller's supplied checkout.

The official Cursor Local and DSH fallback CLIs accept their prompt as a
positional argument. During that fallback only, another process running as the
same host user may be able to observe the prompt in the process argument list.
Grok fallback uses an owner-only prompt file. Prefer ACP for sensitive prompts
and do not use the local CLI fallback on a host where the same-user process
boundary is not trusted.

Local worker launch requires Linux with a working `systemd --user` manager,
`systemd-run` 244 or newer, and unified cgroup v2. Co-Engineer places the
worker in a transient scope with `KillMode=control-group` solely so
cancellation reaches detached descendants. This is a lifecycle/cleanup
boundary, not a sandbox: the provider's environment, credentials, network,
filesystem, and shell capabilities are inherited unchanged. Local dispatch
fails closed when it cannot verify this boundary. `setup:check` validates
CLI/worktree dependencies but does not replace the release/live cgroup check.

If managed bootstrap fails before it emits an authoritative receipt/path,
Co-Engineer cannot safely identify or delete an unknown worktree. Inspect
`git worktree list` and the `worktree-bootstrap` lock tooling, and clean only
an exact task/lock that is identified there.

Cursor Cloud receives a remote repository reference and an exact pushed
starting commit SHA. It does not see unpushed local commits. Its provider-
managed branch and any requested PR remain remote artifacts until Codex
reviews them.

`create_pr` is a Cursor Cloud-only request. Local tasks reject it and return
their branch/handoff for Codex to inspect before any push or PR creation.

## Credentials

Grok and Cursor Local use their normal persistent CLI login/session state.
Cursor Cloud uses its normal API key, and DSH uses its normal owner-only
model-key file. Credentials are never accepted as MCP arguments and are not
written to task records. Provider workers inherit the trusted user's normal
environment; use a dedicated account or narrower environment if that trust
model is not appropriate.

Do not put credentials in prompts, repository files, origin URLs, fixtures, or
provider instructions. If a prompt contains a secret accidentally, treat the
provider transcript and task state as exposed and rotate the secret.

## Local state

State is stored below the owner-only
`$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer` directory. Task directories are
`0700`; records, prompts, events, logs, requests, and runtime files are
`0600`. ACP session data and DSH session persistence are owner-only as well.

State contains:

- prompt text and a SHA-256 prompt identifier;
- bounded provider events/results and worker diagnostics;
- local repository/worktree paths, branch names, and commit references;
- opaque local session, cloud agent, run, branch, and PR identifiers.

It can contain sensitive private-repository context. Do not publish or commit
the state directory. Terminal task state is retained for inspection until the
operator deliberately removes that exact task directory after handoff.

## Handoff and cleanup

Terminal managed tasks retain their worktree and branch; completion does not
silently delete evidence. Poll `task`, inspect the receipt, and run:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
```

After merge or deliberate discard, inspect the exact writer lock. A dead lock
may be cleaned only with the exact ID and policy:

```bash
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Remove only the matching branch and terminal task-state directory after the
receipt is no longer needed. Direct-mode tasks have no managed worktree; review
the caller checkout explicitly. Use `cancel` for an active task and verify
that the owned local process group or remote cloud run has stopped. Never
replay a prompt-dispatched task.

Live provider checks do not run in GitHub Actions. Public package validation
checks the packed source for credentials, personal paths, and obsolete runtime
files; live receipts stay on the owner host.
