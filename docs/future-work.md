# Future Work

## R1 bounded-run architecture (3.3.0)

Status: specified, not implemented.

Priority: high
Component: Codex-Co-Engineer
Last updated: 2026-08-21

The accepted architecture for R1 is
[ADR 0001](adr/0001-r1-bounded-run-architecture.md). It defines a 3.3.0 run
as 1–8 independent assignments against one immutable repository/base
identity, with deterministic explicit/profile resolution, no direct mode on
run submissions, disjoint writers, read-only verification, no post-dispatch
fallback or replay, and Codex-only final acceptance.

This worktree does not implement the run runtime, candidate composition,
or `AttentionBatchV1`. Gate A remains the functional release authority;
Gate B context-efficiency and Gate C credit economics stay advisory.

## Durable, low-token agent completion waits

Status: implemented in 3.1.0 with remaining real-host MCP pending-call
measurement.

Priority: high
Component: Codex-Co-Engineer
Last updated: 2026-08-19

### Goal

Allow Codex to delegate a long-running task to Grok, Cursor, or another
provider and wait without waking once per minute. Codex should estimate the
task's expected runtime when it delegates the work and set the execution
deadline to that estimate plus a 20% safety margin. Codex should resume only
when the task finishes or requires attention.

The duration of the wait must not cause recurring Codex inference. Codex uses
tokens to start the wait and to process its eventual result, but the model
should not run while the MCP tool call is pending. Provider token usage remains
separate.

### Implemented MCP contract (five-tool surface)

The five-tool catalog is unchanged. The proposed `wait_until_terminal` and
`reply` operations are parameters on `task`, not additional tools.

```text
delegate(
  ...,
  expected_duration_ms | timeout_ms,
  timeout_ms >= ceil(expected_duration_ms * 1.20) when both are supplied,
  silence_timeout_ms?
)

task(
  task_id,
  wait_ms?,
  wait_until = "progress" | "terminal",
  wake_on_needs_attention = true,
  view = "summary" | "diagnostics",
  cursor?,
  max_bytes?,
  extend_expected_duration_ms?,
  extend_reason?,
  reply?: { session_id, question_id, response }
)
```

Recorded deadline fields are visible on the receipt: `expected_duration_ms`,
`duration_margin` (1.20), `timeout_ms`, `deadline_at`, `deadline_source`, and
`deadline_extensions`. `delegate` requires `expected_duration_ms` or a
backwards-compatible explicit `timeout_ms`. Codex may extend the deadline
before expiry with an explicit reason; the new deadline must be strictly
later, and silent roll-forward is rejected.

`wait_until: "terminal"` is event-driven (`fs.watch`) with a 15-second local
fallback only after watcher failure. Cancelling the MCP tool call aborts the
waiter (`wait_reason: "disconnected"`) and does not terminate provider work.

### Remaining real-host acceptance

This worktree did **not** run 5-minute, 30-minute, or 4-hour Codex Desktop
pending-call measurements. Repository evidence for the previous 60-second
`wait_ms` / 65-second `tool_timeout_sec` pair is only an implementation
setting, now raised to a 4-hour advertised budget (`14400000` ms /
`tool_timeout_sec` 14405). That budget is not a measured Desktop hard limit.

Procedure: [mcp-pending-call.md](mcp-pending-call.md) and
`scripts/mcp-pending-call-probe.mjs`. If Desktop cuts a call earlier than the
recorded deadline, reconnect from `event_cursor` without replaying events.

Live systemd/cgroup lifecycle remains covered by the existing process-boundary
preflight and local-provider dispatch fail-closed path. Opt-in provider-backed
acceptance is still required for Grok, Cursor Local, Cursor Cloud, and DSH.

### Non-goals (unchanged)

- Creating additional Codex tasks or chats automatically.
- Unsolicited MCP callbacks when no Codex request is active.
- Waking Codex for every text delta, tool invocation, or routine heartbeat.
- Keeping provider work only in MCP process memory.
