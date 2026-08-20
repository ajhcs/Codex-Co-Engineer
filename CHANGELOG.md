# Changelog

## [Unreleased]

## [3.1.0] - 2026-08-19

Wait for delegated work until it reaches a terminal or needs-attention
state, without waking on routine text deltas. Deadlines are recorded with
a visible 20% margin. Diagnostics, deadline extension, and reply are
parameters on the existing five-tool catalog.

**Limitation:** 5-minute, 30-minute, and 4-hour Codex Desktop measurements
were not executed in this worktree. The 4-hour MCP pending-call budget is
advertised, not a measured Desktop hard limit. If the host cuts the call
earlier, reconnect from `event_cursor`.

### Added

- **Recorded deadlines.** `delegate` records `expected_duration_ms`, a
  visible 20% margin, and
  `deadline_at = created_at + ceil(expected_duration_ms * 1.20)`. Explicit
  `timeout_ms` overrides are stored as `deadline_source: "explicit"`.
  Deadline extensions require `extend_expected_duration_ms` plus
  `extend_reason` and are appended to `deadline_extensions`; the deadline
  is never rolled silently.
- **Terminal waits.** `task` `wait_until: "terminal"` waits for a terminal
  or needs-attention state without waking on routine text deltas.
  Disconnecting the waiter or cancelling the MCP call does not stop or
  own provider work.
- **Summary and diagnostics views** on `task`. Diagnostics are
  side-effect free, cursor-paged, byte-capped, and secret-redacted.
  Alerts use a normalized diagnostic envelope instead of a bare `ERROR`.
- **Same-session, exactly-once `task.reply`** for Grok and Cursor Local
  ACP sessions. DSH, Cursor Cloud, and CLI fallback report
  `same_session_reply_unsupported` rather than starting a new prompt.
- **Provider capability reporting** on `status` and task receipts,
  including live progress, reply, restart recovery, cancellation
  confirmation, and evidence class.
- **Durable restart reconciliation** of unfinished tasks, including
  deadline expiry when the worker is gone and immediate wake when
  attention is still required.
- **Deterministic MCP pending-call probe** and a documented real-host
  acceptance procedure. 5-minute, 30-minute, and 4-hour Codex Desktop
  measurements were not executed in this worktree.

### Fixed

- **Deadline margin.** Keep expected-duration and timeout maxima separate
  so the recorded deadline is always at least
  `ceil(expected_duration_ms * 1.20)` instead of silently capping the
  margin. Explicit `timeout_ms` must meet that floor. `delegate` requires
  `expected_duration_ms` or a backwards-compatible `timeout_ms`.
- **Strict extensions.** Reject deadline extensions that would not move
  `deadline_at` strictly later.
- **Diagnostics paging.** Skip a single oversized event line and advance
  the cursor; last-activity reads the event-log tail in bounded chunks.
- **Reply watchers.** Same-session reply watchers attach an error handler,
  re-arm once, then use the low-frequency fallback. Unmatched reply text
  fails closed to `cancel`.
- **Secret redaction.** Public MCP receipts redact secrets in `result`,
  errors, nested handoff, and events.
- **Lifecycle evidence.** Public receipt sanitization keeps
  `prompt_dispatched` lifecycle evidence while still omitting raw prompt
  content.
- **Cursor Cloud waits.** Run-completion waits re-arm when an audited
  deadline extension is persisted.
- **Omitted terminal waits.** Omitted `wait_until=terminal` waits re-read
  `deadline_at` and re-arm the task-deadline timer when another client
  records an audited extension. Explicit `wait_ms` remains a fixed
  caller-selected connection cap.
- **Pinned DSH setup.** Pin vendored DSH ACP demo peerDependencies to
  exact `0.1.0-rc.7` and install that same composition explicitly so
  `npm run setup` cannot resolve a later release candidate such as
  `dsh-acp@0.1.0-rc.8`.

### Changed

- **Five-tool catalog unchanged.** Terminal wait, diagnostics, deadline
  extension, and reply are parameters on `task` / `delegate`.
- **Advertised 4-hour pending-call budget.** Raise the plugin-advertised
  MCP pending-call budget to 4 hours (`wait_ms` max 14400000,
  `tool_timeout_sec` 14405). This is an advertised budget, not a measured
  Desktop hard limit. If the host cuts the call earlier, reconnect from
  `event_cursor`.
- **15-second watcher fallback.** Watcher failure during a terminal wait
  uses a 15-second local fallback rather than rapid polling.

## [3.0.2] - 2026-08-19

### Fixed

- Project a compact live `last_event` / `progress` snapshot from the
  append-only event log so `task` and `status` no longer stay stale while
  ACP workers are streaming. `task.json` is still not rewritten on every
  text delta.
- Extend `task` with optional bounded `wait_ms` and `cursor` wait
  arguments so Codex can wait for meaningful progress or a terminal state
  instead of hammering empty polls. Waits are event-driven; text deltas
  are coalesced and event-log catch-up is memory-bounded. Unsolicited
  stdio callbacks across assistant turns are not available.
- Read the configured `remote.origin.url` for Cursor Cloud so host
  `insteadOf` credential rewrites cannot leak into receipts or fail
  dispatch.

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
