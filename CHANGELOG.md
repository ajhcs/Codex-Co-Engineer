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
  partial Messages-format streaming controls; review/verify normalize legacy
  permission aliases to noninteractive `auto` under the hard read-only
  sandbox.
- Documentation for official installation/authentication prerequisites and the
  deliberate ACP, worktree, prompt-file, and system-prompt-override omissions.
- Cursor Cloud Control plugin with typed Cursor Cloud Agents API v1 lifecycle,
  bounded SSE/polling, usage, artifact, and archive/delete operations.
- Packaged (but not production-exposed) Cursor Local Control foundation for the
  locally installed Cursor Agent CLI, with separate owner-only state and
  receipts, explicit read-only and isolated-worktree policies, bounded NDJSON
  logs, and owned cancellation for later host acceptance. Only local
  status/auth/permissions diagnostics are ready for use; run dispatch remains
  fail-closed and unwired pending real Cursor plus Bubblewrap acceptance. The
  adapter never accepts Cloud IDs or shares Cloud credentials, state, or
  receipts.
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

- Co-Engineer is versioned `2.1.1`; the supported worker-kind contract
  is now exactly `deepseek_agent` and `grok_build`.
- The Grok auth doctor now treats an exit-zero CLI response that explicitly
  says the user is unauthenticated as unauthenticated, and the typed Grok
  reasoning vocabulary is normalized to the installed CLI's supported
  `low`/`medium`/`high`/`xhigh` values.
- MCP-launched Co-Engineer daemons are bound to the resolved owner-only model
  API key file, including when the legacy environment alias is used.
- Public direct Grok dispatch keeps sandbox enforcement inside the official
  CLI. The separately packaged outer-boundary experiment is not runtime-wired
  and still requires real host/systemd acceptance.
- Review and verify dispatch rejects catch-all/write-capable permission rules,
  refuses project-local Grok, Cursor/Claude compatibility, or MCP configuration
  before provider startup, and isolates Grok capacity probes from repository
  working directories.
- Co-Engineer `2.1.1` uses Grok's noninteractive `auto` permission mode for
  implement jobs and fails closed when an implement run exits without an
  allowed workspace change.
- Cursor Cloud Control `0.3.0` packages the distinct local Cursor CLI
  foundation but keeps it unwired and not exposed in the production catalog;
  only status/auth/permissions diagnostics are ready pending real Cursor plus
  Bubblewrap host acceptance. Its cloud half gives repository discovery and
  repository-backed creation one bounded 60-second attempt, never retries the strictly
  rate-limited inventory endpoint, and degrades discovery timeouts into an
  explicit unavailable result.
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
- Configured provider credentials are standing authorization for task-scoped
  calls; no per-job egress prompt is added. Grok and DSH harness-internal
  subagents can be requested, while receipts keep actual effectiveness
  `unknown` unless provider evidence proves delegation occurred.
- Cursor model discovery is dynamic, custom subagents remain typed and
  bounded, identity responses omit personal fields, and write-mode repository
  dispatch requires an immutable starting commit.

### Removed

- All Prime Intellect integrations, including Prime Agent, Prime Eval, Prime
  CLI compatibility probes, lab diagnostics, environment variables, schemas,
  runner parsing, tests, and runtime patch generation.

Future changes should document protocol, target-contract, lifecycle, and
compatibility effects before implementation details.
