---
name: control-codex-co-engineer-agents
description: Delegate review and implementation work to Grok, Cursor Local, Cursor Cloud, or DeepSeek Harness through the Codex-Co-Engineer ACP-first MCP supervisor. Use for parallel coding, review, task monitoring, worktree-isolated or direct local changes, and cancellation.
---

# Codex-Co-Engineer

Use the five MCP tools for delegation and lifecycle control.

1. Call `status` when provider or supervisor readiness is unknown. Require
   `local_boundary.ready: true` before local dispatch; local provider readiness
   is forced false when the boundary is unavailable.
2. Local dispatch requires Linux, a working `systemd --user` manager,
   `systemd-run` 244 or newer, and unified cgroup v2. `setup:check` checks
   CLI/worktree dependencies; `status`, dispatch preflight, and release/live
   acceptance validate the boundary from their actual MCP environment.
3. Choose `grok`, `cursor-local`, `cursor-cloud`, or `dsh`.
4. Call `delegate` with a stable task ID, absolute Git root, a clear prompt,
   and `expected_duration_ms`. The recorded deadline is
   `ceil(expected_duration_ms * 1.20)` unless `timeout_ms` is an explicit
   override. Do not silently roll the deadline; extend it only with
   `extend_expected_duration_ms` and `extend_reason` before expiry.
5. Use `role: "review"` for analysis and `role: "implement"` for changes.
6. For local tasks, use `workspace_mode: "managed"` by default. Use
   `workspace_mode: "direct"` only when direct mutation of the supplied
   checkout is intentional.
7. For Cursor Cloud, provide a provider-accessible origin and an exact
   immutable commit SHA in `starting_ref` that is already pushed.
   Before final acceptance, make a feature-branch SHA provider-visible through
   an open draft PR or the default branch. Treat an HTTP 400 for an otherwise
   valid SHA as a visibility failure; surface it in the receipt and fix
   reachability before retrying.
8. Set `create_pr` only for Cursor Cloud. Local tasks reject it; Codex
   decides whether local commits justify a PR after inspecting the handoff.
9. Watch with `task`. A bare `task_id` returns the current receipt plus a
   compact `progress` snapshot, normalized `state`, and diagnostic envelope.
   For a durable low-token wait, pass `wait_until: "terminal"` and the
   previous `event_cursor`. Optional `wait_ms` caps one pending MCP call;
   omit it to wait until the recorded deadline, bounded by the advertised
   pending-call budget. The call returns on success, failure, timeout,
   cancellation, transport loss, environment block, needs_attention, silence,
   a corrupt/resource-limit alert, or the advertised MCP pending-call budget.
   Routine text deltas do not wake Codex. Disconnecting the waiter does not
   stop provider work. Use `view: "diagnostics"` only after an alert; it is
   side-effect free and never waits. Deliver a same-session answer with
   `reply: { session_id, question_id, response }` exactly once when the
   provider capability allows it; otherwise the error is explicit. Never
   replay an active or prompt-dispatched task. Unsolicited stdio callbacks
   across assistant turns are not available.
10. Use `cancel` for explicit cancellation or verified orphan recovery.
11. Inspect commits, handoff, and receipts before Codex merges anything.

Grok and Cursor Local use persistent ACP sessions. DSH uses the official rc.7
ACP composition through ACPX. Cursor Cloud uses the official Cursor SDK. A
local CLI fallback is allowed only when ACP fails before prompt dispatch. ACPX
does not provide an authoritative prompt-sent acknowledgement; after ACPX
spawns, DSH receipts say `dispatch_uncertain` and never fall back to CLI.

The manager-owned transient systemd user service used for local workers sets
`KillMode=control-group` only so cancellation reaches detached descendants and
workers survive the launching client. It is not a sandbox and
does not restrict environment, network, filesystem, credentials, or shell
capabilities. Local dispatch fails closed if the boundary is unavailable.

Use normal persistent provider authentication. Never put credentials in MCP
arguments or prompts. Configured provider sessions are standing authorization
for task-scoped calls; preserve normal approval boundaries for deployments,
destructive Git operations, and merges.

Managed local tasks follow:

```text
one task -> one worktree -> one branch -> one writer
```

If bootstrap fails before an authoritative receipt/path exists, do not guess
or delete a worktree. Inspect `git worktree list` and the
`worktree-bootstrap` lock tooling, then clean only an exact identified task.

Terminal managed tasks retain their worktree for inspection. Obtain the
authoritative handoff before accepting or discarding work:

```bash
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
```

After merge or deliberate discard, inspect the exact writer lock. Clean only a
dead lock with its reported ID, then remove the exact worktree/branch and
terminal task-state directory when its receipt is no longer needed:

```bash
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Direct-mode tasks have no managed worktree, so inspect the caller checkout
explicitly. Prompts and repository content can leave the machine for the
selected provider; send only material that provider is authorized to process.
