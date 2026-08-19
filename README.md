# Codex-Co-Engineer

Codex-Co-Engineer is a small stdio MCP supervisor that lets Codex delegate
real review and implementation work to authenticated peer coding agents:

- Grok Build on the local host
- Cursor Local
- Cursor Cloud
- DeepSeek Harness (DSH) with Muse Spark

Codex remains the chief engineer, reviewer, and merge authority. Providers
retain their normal coding capabilities, persistent logins, shell access, and
dependency installation. Co-Engineer adds lifecycle tracking, optional local
worktree isolation, bounded cancellation, and useful receipts—not another
sandbox or policy engine.

The stable plugin identifier is `plumbob-harness-control`. Version 3 exposes
five tools: `status`, `delegate`, `task`, `tasks`, and `cancel`.

## Install

Requirements:

- Node.js 24 or newer. The release gate is intentionally pinned to Node 24.
- Git and the `worktree-bootstrap` CLI/skill for managed local workspaces.
- Linux with a working `systemd --user` manager, `systemd-run` 244 or
  newer, and a unified cgroup v2 hierarchy for local providers.
- Authenticated Grok Build and Cursor Local CLIs.
- A Cursor Cloud API key in its normal owner-only configuration file.
- The DSH/Muse model credential in its normal owner-only configuration file.

Install the plugin through Codex, then run its one-time setup from the
installed plugin package directory—the directory containing `package.json`
and `bin/setup.mjs`. In this source checkout that directory is:

```bash
cd plugins/plumbob-harness-control
npm run setup
npm run setup:check
```

For a Codex-managed installation, use the package path reported by Codex or
its plugin manager instead of assuming it is relative to the current project.

Setup installs the pinned ACPX, Cursor SDK, and cohesive DSH rc.7
composition, creates owner-only DSH configuration/session directories, and
does not perform provider login. Authenticate providers once through their
normal flows; their sessions persist across Codex tasks:

```bash
grok login
cursor-agent login
bin/set-model-api-key
```

`npm run setup:check` validates the DSH/ACPX composition and CLI, Cursor SDK,
and `worktree-bootstrap` dependency. It does not install or authenticate Grok
or Cursor Local or validate the Cursor Cloud key. Call `status` after setup:
its `local_boundary` result verifies the Linux systemd/cgroup prerequisite in
the MCP process's actual environment, and local providers are reported
unavailable when that boundary is unavailable. The release gate also launches
the MCP through the manifest's exact environment allowlist before accepting a
local-provider release.

Cursor Cloud uses `CURSOR_API_KEY`,
`CURSOR_API_KEY_FILE`, or the existing owner-only
`~/.config/cursor-cloud-control/api-key`. The DSH key defaults to the
owner-only `~/.config/codex-co-engineer/model-api-key`. Never put credentials
in MCP arguments or prompts.

## Delegation model

Local Grok and Cursor tasks use ACP. DSH uses the official rc.7 ACP
composition through ACPX. Cursor Cloud uses the official Cursor SDK. A local
CLI fallback is allowed only when ACP fails before prompt dispatch; an
accepted prompt is never replayed through another transport. ACPX does not
provide an authoritative prompt-sent acknowledgement, so a DSH task is marked
`dispatch_uncertain` as soon as ACPX spawns and is never replayed through CLI.

Every local worker is launched as a manager-owned transient `systemd --user`
service with `KillMode=control-group` solely so cancellation reaches detached
descendants and the worker survives the launching client. This is a
lifecycle/cleanup boundary, not a sandbox: providers inherit the normal
environment, network, filesystem, credentials, and shell capabilities. Local
dispatch fails closed when the Linux systemd/cgroup prerequisite is not
available. This check occurs before Co-Engineer creates a managed worktree,
task receipt, or prompt file. Cursor Cloud runs in the provider's remote
environment and does not depend on the local process boundary.

Cursor Local and DSH's official fallback CLIs take the prompt positionally,
so it may be visible to other processes running as the same Unix user for the
duration of that fallback. Grok fallback uses an owner-only prompt file.

### Local workspace modes

Local providers accept `workspace_mode`:

- `managed` (default) creates and locks one
  `worktree-bootstrap` worktree and branch per task. This is the normal mode
  for parallel implementation and review.
- `direct` runs against the supplied checkout. Use it only when you
  explicitly accept direct mutation of that checkout.

The invariant for managed tasks is:

```text
one task → one worktree → one branch → one writer
```

If `worktree-bootstrap` fails before returning an authoritative receipt and
path, Co-Engineer does not guess at or delete an unknown worktree. Inspect the
repository with `git worktree list` and the `worktree-bootstrap` lock tooling;
clean only an exact task/lock that the tooling identifies.

### Cursor Cloud requirements

Cursor Cloud does not use a local worktree. The supplied repository must have
an origin that Cursor can access, and `starting_ref` must be an exact,
immutable commit SHA that has already been pushed to that origin. This avoids
silently sending a different local branch state to the remote provider.

An exact SHA that is reachable only from a feature branch can still be
invisible to Cursor until that branch is provider-visible through an open
pull request or the default branch. Create the draft PR (or make the commit
reachable from the default branch) before final Cloud acceptance. If Cursor
returns HTTP 400 for an otherwise-valid SHA, surface it as a provider
visibility failure in the receipt and fix reachability before retrying; do not
blindly replay the task.

`create_pr` is a Cursor Cloud-only option and defaults to `false`. Local
tasks reject it. A local implementation returns its branch and handoff for
Codex to inspect; Codex may push and open a PR only after confirming that real
commits exist. Codex controls the final merge.

Example local review:

```json
{
  "task_id": "review-auth-refactor",
  "provider": "grok",
  "repo": "/absolute/path/to/git-worktree",
  "role": "review",
  "workspace_mode": "managed",
  "prompt": "Review the current branch and report concrete correctness risks.",
  "timeout_ms": 3600000
}
```

Example Cursor Cloud implementation:

```json
{
  "task_id": "cloud-auth-refactor",
  "provider": "cursor-cloud",
  "repo": "/absolute/path/to/clean-checkout",
  "role": "implement",
  "starting_ref": "0123456789abcdef0123456789abcdef01234567",
  "prompt": "Implement the requested change, run tests, and commit the result.",
  "create_pr": true
}
```

Providers are `grok`, `cursor-local`, `cursor-cloud`, and `dsh`. Roles
are `review` and `implement`.

## Handoff and cleanup

Terminal managed tasks retain their worktree and branch for Codex inspection;
they are not silently deleted. Poll `task`, then run the authoritative
handoff from the recorded worktree:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
```

Inspect commits, diff, tests, and ownership evidence before pushing or opening
a PR. After merge or deliberate discard:

```bash
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Clean only the exact corresponding branch and terminal task-state directory
after its receipt is no longer needed. Direct tasks have no managed worktree;
review their caller checkout explicitly. Cursor Cloud agents are archived
after terminal completion where supported, while their remote branch/PR
remains for Codex review.

## Data and credentials

Selecting a provider authorizes the task prompt and repository content to be
sent to that provider. Private repositories are supported when the configured
provider is authorized to review them. Provider children inherit the user's
normal authenticated environment because they are trusted peer coding agents.

Task prompts, events, logs, runtime identities, local paths, branch names, and
opaque provider IDs are stored under the owner-only state directory, normally
`$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files are
`0600`. Prompts and session data are retained for inspection until the
operator removes the exact terminal task state. See
[data handling](docs/data-handling.md).

## Development and release

```bash
npm --prefix plugins/plumbob-harness-control test
node scripts/validate-release.mjs
node scripts/inspector-preflight.mjs
```

The authoritative release gate runs against one exact local candidate using
Node 24. GitHub Actions is a credential-free mirror; live Grok, Cursor,
Cursor Cloud, and DSH acceptance is recorded separately because CI must not
send repository content to model providers.

The older `cursor-cloud-control` package remains in this repository as a
compatibility plugin for existing installations. New installations need only
Codex-Co-Engineer 3.x.

## License

MIT. See [LICENSE](LICENSE).
