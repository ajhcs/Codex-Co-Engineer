# Changelog

## [Unreleased]

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
