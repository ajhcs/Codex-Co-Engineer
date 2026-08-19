# MCP pending-call budget

Codex-Co-Engineer 3.1.0 advertises a 4-hour pending MCP tool-call budget so a
`task(wait_until="terminal")` call can cover a multi-hour delegated job
without once-per-minute model wakeups. This is a plugin setting, not a
measured Codex Desktop hard limit.

| Setting | Value | Source |
| --- | --- | --- |
| Advertised wait budget | 14,400,000 ms (4 hours) | `MCP_PENDING_CALL_BUDGET_MS` |
| Plugin `tool_timeout_sec` | 14405 | `.mcp.json` (budget/1000 + 5s margin) |
| Previous 3.0.2 pair | 60,000 ms / 65s | Implementation setting, not a product limit |
| Measured Desktop 5 / 30 / 240 min | **unmeasured in this worktree** | Must be run on a real Codex Desktop host |

The supervisor reports this as `status.mcp_pending_call`.
`measured_desktop_limit_ms` is `null` until an operator records a real-host
result. If a wait hits the advertised budget before the task deadline,
`wait_reason` is `transport_budget` and Codex should reconnect from
`event_cursor`.

## Deterministic fixture (this worktree)

Unit tests cover short, medium, and multi-hour **deadline math**
(`ceil(expected_duration_ms * 1.20)`) with injected clocks and compact
waits. They do not sleep for 4 hours.

`scripts/mcp-pending-call-probe.mjs` is the harness for a real pending-call
measurement. Default duration is 2 seconds. It creates a durable running
task, calls `task(wait_until=terminal, wait_ms=N)`, and reports elapsed
time plus whether the MCP server returned before the requested wait.

## Real-host acceptance procedure

Run these on the Codex Desktop host that will ship, with the 3.1.0 plugin
installed and a Linux systemd/cgroup-ready environment. Do not run them in
CI.

1. Confirm `status.local_boundary.ready` is true.
2. Probe from this repository:

   ```bash
   node scripts/mcp-pending-call-probe.mjs --wait-ms 120000
   node scripts/mcp-pending-call-probe.mjs --wait-ms 300000    # 5 minutes
   node scripts/mcp-pending-call-probe.mjs --wait-ms 1800000   # 30 minutes
   node scripts/mcp-pending-call-probe.mjs --wait-ms 14400000  # 4 hours
   ```

3. Repeat each interval from Codex Desktop itself: delegate a long-running
   fixture (or keep a task in `running`) and call
   `task({ wait_until: "terminal", wait_ms })` once. The model must not
   resume until the tool call returns.
4. While a wait is pending, verify:
   - sending another user message does not kill the delegated worker
   - closing/restarting Codex Desktop does not kill the delegated worker
   - restarting the MCP server leaves the worker running (systemd user
     service) and a later `task` call resumes from `event_cursor`
   - `cancel` still stops the owned process group
   - `notifications/cancelled` on the wait returns `wait_reason:
     disconnected` and leaves the task running
5. Record the longest interval that stayed pending without a host-side
   timeout. If that interval is shorter than 4 hours, keep reconnecting
   from `event_cursor` at that interval and update
   `mcp_pending_call.measured_desktop_limit_ms` in a follow-up.

This worktree must not claim those Desktop intervals were measured.
