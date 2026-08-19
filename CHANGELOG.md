# Changelog

## [Unreleased]

## [3.0.2] - 2026-08-19

### Changed

- Adopt `codex-co-engineer` as the package, plugin, MCP server, skill, and
  repository-path identifier. Human-facing branding is Codex-Co-Engineer.
- Remove leftover environment fallbacks and vendor package names from the
  previous identity.
- Rewrite the root and plugin READMEs around the current 3.x supervisor,
  provider matrix, workspace model, and discovery/install paths.

## [3.0.1] - 2026-08-19

### Fixed

- Forward the user-session runtime and D-Bus locators required by transient
  `systemd --user` services when Codex applies the plugin environment
  allowlist.
- Report local process-boundary readiness through `status` and fail local
  providers closed before creating a worktree, task receipt, or prompt file.
- Wait for the `systemd-run` client result so queueing failures are classified
  accurately instead of surfacing as a later unit-inspection failure.
- Keep the stdio server alive while its newly connected client prepares the
  first JSON-RPC frame.
- Exercise the exact manifest-filtered MCP environment in the authoritative
  release gate.

## [3.0.0] - 2026-08-19

### Added

- Five-tool multi-agent supervisor for Grok Build, Cursor Local, Cursor Cloud,
  and DeepSeek Harness/Muse.
- ACP-first local execution, official Cursor SDK cloud execution, and a
  cohesive official DSH rc.7 ACP composition.
- Persistent normal provider authentication with owner-only local credential
  discovery; no credentials in MCP arguments or receipts.
- Managed `worktree-bootstrap` workspaces for every local review and
  implementation task.
- Durable task receipts, stable cloud idempotency, restart reconciliation, and
  bounded process-group and remote-run cancellation.
- One setup/check command for pinned local dependencies and DSH configuration.

### Changed

- Codex is explicitly the chief engineer and merge authority; peer providers
  retain normal coding, shell, and dependency-installation capabilities.
- Cursor Local and Cursor Cloud are both first-class providers in the main
  Co-Engineer plugin.
- CLI fallback is limited to failures proven to occur before prompt dispatch.
- Release validation now tests the five-tool 3.x catalog and package instead of
  the 2.x target-attestation and outer-sandbox experiments.

### Removed

- The seven-tool 2.x control plane, target fingerprints, capacity subsystem,
  daemon/runtime UI controls, direct-headless policy layer, and experimental
  Bubblewrap/attestation outer-sandbox paths. Local workers retain only a
  lifecycle-only systemd user-scope cgroup boundary for descendant cleanup;
  it is not a provider sandbox or an attested execution boundary.
- Packaged legacy MCP modules, tests, and DSH headless overlays.

## [2.1.2] - 2026-08-18

- Final 2.x target-bound Co-Engineer and Cursor compatibility release.

## [1.0.0] - 2026-08-16

- Initial public Codex-Co-Engineer release.
