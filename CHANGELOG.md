# Changelog

All notable public changes to Codex-Co-Engineer are recorded here.

## [Unreleased]

No unreleased changes.

## [2.2.0] - 2026-08-19

### Added

- Control-plane target binding can resolve and attest the selected local or
  staged target while preserving the strict path, Git identity, and postflight
  contract.
- Terminal Co-Engineer jobs expose a bounded final response alongside their
  lifecycle receipt, so callers do not need to parse the complete provider log
  to retrieve the result.
- Cursor Cloud Control `0.4.0` adds explicit reconciliation for uncertain
  creates and keeps provider-assigned IDs distinct from local reservations.
- Cursor Local Control is exposed as wire identity `0.2.0` with an explicit
  administrator opt-in for host-trusted direct-CLI runs; status remains the
  default catalog surface and Cloud/local state stays separate.

### Changed

- Co-Engineer runtime and final-response handling now fail closed when target
  binding or durable completion cannot be confirmed.
- Cursor Cloud reconciliation retries only bounded provider-absence checks and
  never resubmits an uncertain mutation; definitive conflicts and rate limits
  remain failed provider responses.
- Release validation, activation fixtures, Inspector examples, and package
  inventories identify the current Co-Engineer `2.2.0` and Cursor `0.4.0`
  surfaces without changing the independently pinned ACPX runtime.

## [2.1.2] - 2026-08-18

### Added

- First-class `grok_build` run kind using the official Grok Build CLI directly
  in noninteractive headless mode with typed, validated controls.
- Grok model, output, session, reasoning, sandbox, permission, tool, and
  bounded policy fields with role ceilings, streaming-log parsing, OAuth-aware
  status diagnostics, and fake-CLI coverage.
- Bounded typed JSON Schema structured output, exact prompt transport, and
  partial Messages-format streaming controls; review/verify normalize legacy
  permission aliases to noninteractive `auto` under the hard read-only
  sandbox.
- Documentation for official installation/authentication prerequisites and the
  deliberate ACP, worktree, prompt-file, and system-prompt-override omissions.
- Cursor Cloud Control plugin with typed Cursor Cloud Agents API v1 lifecycle,
  bounded SSE/polling, usage, artifact, and archive/delete operations.
- Cursor Local Control with an administrator-activated,
  `execution_profile: "host_trusted"` direct Cursor CLI surface. The public
  default remains status/auth/permissions only; host-trusted reads use Ask
  mode, explicit implement calls use `--force` and an isolated worktree, and
  receipts identify process-user authority with no outer sandbox claim. Local
  state, credentials, IDs, and receipts remain separate from Cursor Cloud.
- Owner-only credential handling, durable mutation ledger, redacted receipts,
  and artifact path/overwrite protections.
- Cursor MCP preflight, plugin validation, unit coverage, and package inventory
  checks alongside the existing Co-Engineer release gate.
- Explicit read-only Co-Engineer `capacity` tool for official Codex App Server
  rate-limit/credit data, Grok ACP billing/session usage, and exact DSH job
  receipts; unsupported account capacity and spend remain unknown.
- Pinned ACPX runtime, bounded ACP transport/ledger/schema/resource helpers,
  and a Bubblewrap-based Grok outer-boundary conformance suite. These modules
  are packaged but remain gated and unwired: there is no public sessions tool
  and direct Grok dispatch does not use the outer boundary.

### Changed

- Co-Engineer is versioned `2.1.2`; the supported worker-kind contract
  is now exactly `deepseek_agent` and `grok_build`.
- The Grok auth doctor now treats an exit-zero CLI response that explicitly
  says the user is unauthenticated as unauthenticated, and the typed Grok
  reasoning vocabulary is normalized to the installed CLI's supported
  `low`/`medium`/`high`/`xhigh` values.
- MCP-launched Co-Engineer daemons are bound to the resolved owner-only model
  API key file, including when the legacy environment alias is used.
- Public direct Grok dispatch keeps sandbox enforcement inside the official
  CLI. The separately packaged outer-boundary experiment is not runtime-wired
  and still requires real host/systemd acceptance. Its Bubblewrap provider now
  stays in the one owned detached process group, and bounded cleanup verifies
  that both the launcher and group have drained before reporting success.
- Review and verify dispatch rejects catch-all/write-capable permission rules,
  refuses project-local Grok, Cursor/Claude compatibility, or MCP configuration
  before provider startup, and isolates Grok capacity probes from repository
  working directories.
- Co-Engineer `2.1.2` persists the validated worker kind into each internal
  runner specification, restoring the protected DSH credential allowlist and
  Grok's kind-specific HOME guard. It uses Grok's noninteractive `auto`
  permission mode for implement jobs and fails closed when an implement run
  exits without an allowed workspace change.
- Cursor Cloud Control `0.3.0` packages the distinct local Cursor CLI surface;
  its public default catalog remains status/auth/permissions only, while an
  administrator may explicitly activate the host-trusted direct-CLI profile.
  The retained Bubblewrap foundation remains separate and unwired, and each
  host-trusted installation still requires real Cursor process acceptance.
  Its cloud half gives repository discovery and repository-backed creation one
  bounded 60-second attempt, never retries the strictly rate-limited inventory
  endpoint, and degrades discovery timeouts into an explicit unavailable result.
- DeepSeek Harness is invoked directly in the attested target checkout and is
  validated independently through its own CLI version.
- DeepSeek headless and web jobs use a managed absolute DSH profile/state root,
  materialize the bundled Muse Spark 1.2 Contributor overlay without reading a
  provider key, and fail closed with a readiness reason instead of falling
  back to a protected `~/.dsh` path.
- Root and plugin documentation now describe every MCP tool, accepted worker
  kind, required target fields, monitoring call, and credential boundary.
- Co-Engineer status remains a compact health check; provider capacity reads
  are explicit, selector-aware, compactly cached, and stale-on-refresh-failure.
- Grok ACP is limited to read-only capacity telemetry; coding dispatch remains
  on the direct headless CLI interface.
- Configured provider credentials or sessions are reused as standing
  authorization for task-scoped calls; normal provider expiry or revocation
  can still require reauthentication, and no per-job egress prompt is added.
  Grok and DSH harness-internal subagents can be requested, while receipts keep
  actual effectiveness `unknown` unless provider evidence proves delegation
  occurred.
- Cursor model discovery is dynamic, custom subagents remain typed and
  bounded, identity responses omit personal fields, and write-mode repository
  dispatch requires an immutable starting commit.

### Removed

- Legacy provider integrations and compatibility surfaces that are not part of
  the public control-plane release, including their private runtime hooks.

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
- Generated runtime, state, and credential paths remain outside the public
  release boundary.

Future changes should document protocol, target-contract, lifecycle, and
compatibility effects before implementation details.
