# Security policy

Codex-Co-Engineer is a trusted operator-plane integration. It starts
authenticated peer coding agents that can read and modify a repository,
execute shell commands, install dependencies, and send selected prompts and
repository content to an external provider. It is not a read-only security
sandbox, and it does not replace the provider's normal approval or account
controls.

## Supported versions

Security fixes target the latest release on the default branch. Report the
stable MCP identifier `codex-co-engineer` together with the public
package version.

## Report privately

Do not open a public issue for an undisclosed vulnerability. Use the
repository's GitHub **Security** tab to create a private vulnerability report
or contact the maintainers through the private channel configured there.
Include the affected version, impact, a minimal reproduction, and the
smallest safe log excerpt. Never attach credentials, full prompts, private
repository contents, or unredacted provider payloads.

## Trust and execution boundary

- Selecting a provider authorizes that provider to receive the task prompt and
  the repository material needed for the task. Only delegate repositories that
  the provider is authorized to process.
- Local Grok, Cursor Local, and DSH tasks use ACP first. A local CLI fallback
  is permitted only when ACP fails before prompt dispatch; once dispatch has
  started, the task is reconciled or cancelled rather than replayed.
- Cursor Local and DSH's official fallback CLIs take the prompt positionally,
  so the prompt can be visible in same-user process arguments during that
  fallback. Grok fallback uses an owner-only prompt file. Treat the local Unix
  account as part of the trusted boundary.
- Local workers require Linux, a working `systemd --user` manager,
  `systemd-run` 244 or newer, and unified cgroup v2. Co-Engineer uses a
  manager-owned transient systemd user service with
  `KillMode=control-group` solely to stop detached descendants during
  cancellation and let the worker survive the launching client. This is not a
  sandbox and does not restrict the provider's environment, credentials,
  network, filesystem, or shell capabilities; local dispatch fails closed when
  it is unavailable.
- Local tasks default to a managed `worktree-bootstrap` worktree. An explicit
  `workspace_mode: "direct"` request may run against the supplied checkout,
  so direct mode must be treated as full mutation of that checkout.
- If managed bootstrap fails before an authoritative receipt/path exists,
  Co-Engineer cannot safely identify or delete an unknown worktree. Inspect
  `git worktree list` and the `worktree-bootstrap` lock tooling, then clean
  only an exact identified task/lock.
- Cursor Cloud is a remote provider. Its repository must have a provider-
  accessible origin and `starting_ref` must identify an exact, immutable
  commit SHA that is already pushed. A SHA reachable only from a feature branch
  may remain invisible until an open PR or default-branch reachability exposes
  it to the provider; create a draft PR before final acceptance and treat a
  provider HTTP 400 for an otherwise-valid SHA as a visibility failure. Do not
  put credentials in an origin URL or blindly replay the task.
- `create_pr` is a Cursor Cloud-only option. Local tasks reject it; local
  commits are handed off for Codex to inspect and push or turn into a PR.
  Codex remains the merge authority.

## Credentials and persistent sessions

Provider authentication is normal, persistent user authentication:

- Grok and Cursor Local use their CLI-managed login/session state.
- Cursor Cloud uses `CURSOR_API_KEY` or its owner-only key file.
- DSH uses `MODEL_API_KEY` or the owner-only model-key file created by
  `bin/set-model-api-key`.

Credentials are not MCP arguments, prompts, task records, or committed files.
The supervisor may inherit the user's normal provider environment because
these are trusted peer coding agents; use a dedicated account or narrower
environment when that trust boundary is not appropriate.

## State, sessions, and retention

Task state is created below the owner-only
`$XDG_STATE_HOME/codex-co-engineer` (or
`~/.local/state/codex-co-engineer`) directory. Task directories are
`0700`; records, prompts, events, logs, requests, and runtime files are
`0600`. ACP session state and DSH session persistence are also kept
owner-only. State contains prompts, bounded provider output, local paths,
branch names, and opaque provider identifiers; do not publish it.

State is retained for inspection until the operator deliberately removes the
exact terminal task directory. Never delete the state root or another task's
directory as a cleanup shortcut.

## Handoff and cleanup

Terminal local tasks leave their managed worktree and branch in place so Codex
can inspect the result. The safe handoff sequence is:

1. Poll `task` until terminal and inspect the receipt.
2. From the recorded worktree, run
   `worktree-bootstrap handoff TASK --repo WORKTREE --format markdown`.
3. Review the reported commits, diff, tests, and ownership evidence before
   pushing or opening a PR.
4. After merge or deliberate discard, inspect the writer lock. If a dead
   writer still owns it, clean only the exact lock ID with
   `worktree-bootstrap lock clean TASK --repo WORKTREE --policy dead-local
   --lock-id LOCK_ID`.
5. Remove only the recorded worktree and, when appropriate, its exact branch
   with normal Git commands. Retain or remove only that task's state directory
   after the receipt is no longer needed.

Cursor Cloud agents are archived after terminal completion when the provider
allows it. Their remote branch and any requested PR remain remote artifacts
until Codex reviews or closes them. Use `cancel` for explicit cancellation
and verify the remote run is stopped; never replay a prompt-dispatched task.

If an invariant or cleanup step fails, stop using the affected checkout,
preserve the minimum redacted evidence, and report it privately.
