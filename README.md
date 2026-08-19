# Codex-Co-Engineer

Codex-Co-Engineer is a small stdio MCP supervisor that lets Codex delegate
real review and implementation work to authenticated peer coding agents:

- Grok Build on the local host
- Cursor Local
- Cursor Cloud
- DeepSeek Harness (DSH) with Muse Spark

Codex remains the chief engineer and merge authority. The providers keep their
normal coding capabilities, persistent logins, shell access, and dependency
installation. Co-Engineer adds lifecycle tracking, isolated local worktrees,
bounded cancellation, and useful receipts—not another sandbox or policy engine.

The stable plugin identifier is `plumbob-harness-control`. Version 3 exposes
five tools: `status`, `delegate`, `task`, `tasks`, and `cancel`.

## Install

Requirements:

- Node.js 24
- `worktree-bootstrap`
- authenticated Grok Build and Cursor Local CLIs
- a Cursor Cloud API key in its normal owner-only configuration file
- the DSH/Muse model credential in its normal owner-only configuration file

Install the plugin through Codex, then run its one-time setup:

```bash
cd plugins/plumbob-harness-control
npm run setup
```

The setup command installs the pinned ACPX, Cursor SDK, and cohesive DSH rc.7
composition and writes only owner-readable local configuration. It does not
perform provider login. Verify an existing host without changing it:

```bash
npm run setup:check
```

Use the providers' normal login flows when needed:

```bash
grok login
cursor-agent login
```

## Delegation model

Local Grok and Cursor tasks use ACP. DSH uses the official rc.7 ACP composition
through ACPX. Cursor Cloud uses the official Cursor SDK. A CLI fallback is
allowed only when a local ACP process fails before prompt dispatch; an accepted
prompt is never replayed through another transport.

Every local task, including a review, runs in a `worktree-bootstrap` managed
worktree:

```text
one task → one worktree → one branch → one writer
```

This lets providers use their full tools without touching the caller's
checkout. Cursor Cloud uses its provider-managed branch. A pull request is
created only when requested and commits exist; `create_pr` defaults to false.
Codex inspects the result and decides what to merge.

Example MCP call:

```json
{
  "task_id": "review-auth-refactor",
  "provider": "grok",
  "repo": "/absolute/path/to/git-worktree",
  "role": "review",
  "prompt": "Review the current branch and report concrete correctness risks.",
  "timeout_ms": 3600000,
  "create_pr": false
}
```

Providers are `grok`, `cursor-local`, `cursor-cloud`, and `dsh`. Roles are
`review` and `implement`.

## Data and credentials

Selecting a provider authorizes the task prompt and repository content to be
sent to that provider. Co-Engineer never accepts credentials as MCP arguments
or stores them in task receipts. Provider children inherit the user's normal
authenticated environment because they are trusted peer coding agents.

Task prompts, events, logs, and runtime identities are stored under an
owner-only state directory, normally
`$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. See [data handling](docs/data-handling.md).

## Development and release

```bash
npm --prefix plugins/plumbob-harness-control test
node scripts/validate-release.mjs
node scripts/inspector-preflight.mjs
```

The authoritative release gate runs against one exact local candidate. GitHub
Actions is a credential-free mirror; live Grok, Cursor, Cursor Cloud, and DSH
acceptance is recorded separately because CI must not send repository content
to model providers.

The older `cursor-cloud-control` package remains in this repository as a
compatibility plugin for existing installations. New installations need only
Codex-Co-Engineer 3.x.

## License

MIT. See [LICENSE](LICENSE).
