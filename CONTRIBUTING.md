# Contributing

Thanks for helping improve Codex-Co-Engineer. Keep the public repository
focused on the Codex control plane and the DeepSeek Harness integration.

## Before opening a pull request

```bash
node --version                 # Node 24 or newer
cd plugins/plumbob-harness-control
npm test
cd ../..
node scripts/validate-release.mjs
git diff --check
```

Do not run provider-backed jobs as part of a pull request. Use fixture
processes, temporary Git repositories, and redacted test data. A change that
requires an external model should document the manual, opt-in verification
separately.

## Code and contract expectations

- Preserve `plumbob-harness-control` as the stable MCP compatibility ID.
- Validate configuration before resolving a target or starting a process.
- Require exactly one target for every dispatch; never infer it from prompt
  prose or silently fall back after an explicit-target error.
- Canonicalize target/configuration input before hashing and compare the
  caller-supplied fingerprint.
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
