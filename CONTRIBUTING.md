# Contributing

Thanks for helping improve Codex-Co-Engineer. Keep the public repository
focused on the Codex control plane and the DeepSeek Harness integration.

## Before opening a pull request

```bash
node --version                                      # Node 24.x for the local gate
npm --prefix plugins/plumbob-harness-control test
npm --prefix plugins/cursor-cloud-control test
node scripts/validate-release.mjs
git diff --check
```

Do not run provider-backed jobs as part of a pull request. Use fixture
processes, temporary Git repositories, and redacted test data. A change that
requires an external model should document the manual, opt-in verification
separately.

The GitHub Actions workflow runs both plugin suites and the portable fixture,
Inspector, reproducible-build, provenance, and package-inventory checks. It is
a diagnostic mirror, not release authority: GitHub CI does not install the
`release-gate` CLI or prove this host's attested Bubblewrap/cgroup boundary.

The authoritative gate is `local-exact-tree`. Run it from a dedicated clean
worktree containing exactly the candidate files on Linux with Node major 24,
the pinned MCP Inspector `2.2.0`, executable Bubblewrap, and static BusyBox:

```bash
release-gate plan --repo "$PWD"
release-gate run --repo "$PWD"
```

Review the resulting receipt and package inventories. A green GitHub check
cannot replace that local receipt. The gate is provider-free except for its
bounded ACPX provenance/signature metadata checks; never add provider
credentials to CI.

## Code and contract expectations

- Preserve `plumbob-harness-control` as the stable MCP compatibility ID.
- Validate configuration before resolving a target or starting a process.
- Require exactly one target for every dispatch; never infer it from prompt
  prose or silently fall back after an explicit-target error.
- Canonicalize target/configuration input before hashing and compare the
  caller-supplied fingerprint, unless the caller explicitly opts into the
  control-plane binding path.
- Keep absolute deadlines independent from progress heartbeats.
- Emit one terminal state and distinguish client, transport, protocol,
  process-startup, tool, timeout, and cancellation failures.
- Keep credentials, full prompts, protected data, and unredacted payloads out
  of logs, artifacts, tests, and documentation.

## Public/private boundary

Never commit `Secrets/`, `.dsh/`, local state, model registries, provider keys,
or personal Codex configuration. Use
the redacted files under `config/` and `examples/` as templates. If a test
needs a credential-shaped value, generate it in memory or in a temporary
directory and assert only redacted behavior.

## Pull requests and releases

Describe the target contract, lifecycle effects, compatibility impact, and
verification performed. A release PR must pass CI, the release inventory
check, MCP Inspector preflight checks, and a clean package-inventory review.
Update `CHANGELOG.md` for user-visible behavior.
