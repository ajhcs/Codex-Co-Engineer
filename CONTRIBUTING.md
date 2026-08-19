# Contributing

Thanks for helping improve Codex-Co-Engineer. The project is intentionally a
thin trusted supervisor for Grok, Cursor Local, Cursor Cloud, and DeepSeek
Harness (DSH). Keep provider capabilities intact and avoid rebuilding a
second sandbox, target-attestation layer, daemon, or policy engine.

## Before opening a pull request

The package supports Node.js 24 and newer. The authoritative release gate is
deliberately pinned to Node.js 24 for reproducible release evidence.

Local worker acceptance additionally requires Linux, a working
`systemd --user` manager, `systemd-run` 244 or newer, and unified cgroup v2.
That scope uses `KillMode=control-group` only for descendant cleanup; it is
not a sandbox or capability restriction. `npm run setup:check` validates the
CLI/worktree dependencies, while the release/live acceptance validates this
host boundary.

```bash
node --version
npm --prefix plugins/codex-co-engineer test
node scripts/validate-release.mjs
node scripts/inspector-preflight.mjs
git diff --check
```

Do not run provider-backed jobs in CI or as an implicit part of a pull
request. Use fixture processes, temporary Git repositories, and redacted test
data. Live provider acceptance is an explicit, opt-in host check performed
after the provider-free gate.

## Public contract

- Preserve `codex-co-engineer` as the stable MCP/package identifier, present
  the product as Codex-Co-Engineer, and keep the five-tool surface small.
  Extend `task` in place for live wait/progress; do not add a sixth tool.
- Local tasks use ACP first and may use the same provider's CLI only when ACP
  fails before prompt dispatch. Never replay an accepted prompt.
- `workspace_mode: "managed"` is the default for local tasks and creates one
  `worktree-bootstrap` worktree, branch, and writer. An explicit
  `workspace_mode: "direct"` is allowed only when the caller intentionally
  accepts mutation of the supplied checkout.
- `create_pr` is valid only for Cursor Cloud. Local tasks must reject it;
  their commits and handoff are reviewed by Codex before any push or PR.
- Cursor Cloud tasks require a provider-accessible remote and an exact,
  immutable commit SHA in `starting_ref` that has already been pushed.
- Provider authentication is persistent and normal. Do not add login tokens,
  API keys, or credentials to MCP arguments, prompts, task records, fixtures,
  logs, or Git.
- Codex is the final reviewer and merge authority. Provider agents may use
  their normal shell, dependency-installation, and coding capabilities.

## Handoff and cleanup

A successful local task does not silently delete its worktree: the worktree
is retained for inspection. The provider worker records a handoff when it can;
the authoritative manual command is:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
```

Before accepting a change, inspect the handoff, commits, diff, tests, and
ownership evidence. After merge or deliberate discard, inspect the exact
writer lock. Clean a dead lock only with its reported ID:

```bash
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Remove only the corresponding branch and terminal task-state directory after
the receipt is no longer needed. Never delete the whole state root or another
task's worktree. Direct-mode tasks have no managed worktree to clean, so
review their caller checkout explicitly.

## Public/private boundary

Never commit provider keys, local state, ACP/DSH session files, personal Codex
configuration, or private repository material. The public package must remain
free of personal paths, credentials, and machine-specific receipts. Prompts
and selected repository content may leave the machine for the provider chosen
by the operator; tests must use redacted or synthetic data.

## Pull requests and releases

Use focused commits and describe the behavior, lifecycle effects, provider
compatibility, and verification performed. A release PR must pass CI, the
release inventory check, MCP Inspector preflight, ACPX provenance/reproducible
checks, and package-inventory review. Update `CHANGELOG.md` for
user-visible behavior. Codex reviews and merges the release PR only after
those checks and any explicit live acceptance are complete.
