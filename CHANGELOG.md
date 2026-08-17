# Changelog

All notable public changes to Codex-Co-Engineer are recorded here.

## [1.0.0] - 2026-08-16

### Added

- Public Codex-Co-Engineer release surface centered on DeepSeek Harness.
- Stable `plumbob-harness-control` compatibility identifier retained.
- Target, configuration-digest, fingerprint, MCP Inspector, lifecycle, and
  data-handling release contracts.
- Public configuration and preflight examples without credentials or personal
  filesystem paths.
- Release inventory validation and GitHub CI guidance.

### Changed

- User-facing plugin branding is now Codex-Co-Engineer.
- Package metadata is public and versioned `1.0.0`.
- Personal Prime Lab, generated runtime, state, and credential paths are
  explicitly outside the public release boundary.

## [Unreleased]

### Added

- First-class `grok_build` run kind using the official Grok Build CLI directly
  in noninteractive headless mode with typed, validated controls.
- Grok model, output, session, reasoning, sandbox, permission, tool, and
  bounded policy fields with role ceilings, streaming-log parsing, OAuth-aware
  status diagnostics, and fake-CLI coverage.
- Bounded typed JSON Schema structured output, exact prompt transport, and
  partial Messages-format streaming controls; review/verify retain forced plan
  mode.
- Documentation for official installation/authentication prerequisites and the
  deliberate ACP, worktree, prompt-file, and system-prompt-override omissions.
- Cursor Cloud Control plugin with typed Cursor Cloud Agents API v1 lifecycle,
  bounded SSE/polling, usage, artifact, and archive/delete operations.
- Owner-only credential handling, durable mutation ledger, redacted receipts,
  and artifact path/overwrite protections.
- Cursor MCP preflight, plugin validation, unit coverage, and package inventory
  checks alongside the existing Co-Engineer release gate.

### Changed

- Co-Engineer is versioned `2.0.0` because the supported worker-kind contract
  is now exactly `deepseek_agent` and `grok_build`.
- DeepSeek Harness is invoked directly in the attested target checkout and is
  validated independently through its own CLI version.
- Root and plugin documentation now describe every MCP tool, accepted worker
  kind, required target fields, monitoring call, and credential boundary.

### Removed

- All Prime Intellect integrations, including Prime Agent, Prime Eval, Prime
  CLI compatibility probes, lab diagnostics, environment variables, schemas,
  runner parsing, tests, and runtime patch generation.

Future changes should document protocol, target-contract, lifecycle, and
compatibility effects before implementation details.
