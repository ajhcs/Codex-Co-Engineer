---
name: control-codex-co-engineer-agents
description: Debug Co-Engineer MCP payloads, cursors, deadlines, worktrees, or lifecycle internals. Use for explicit troubleshooting; ordinary delegation and existing-run management use their dedicated skills.
---

# Advanced Co-Engineer Control

This is the raw MCP lifecycle skill, not the natural-language Co-Engineer experience. For ordinary outcomes use `$delegate-to-co-engineer`, `$chat-with-co-engineer`, `$use-grok-co-engineer`, `$use-cursor-co-engineer`, or `$use-muse-co-engineer`. Load this skill when the user asks to debug status, payloads, cursors, deadlines, worktrees, or other control-plane internals.

For ordinary launch friction, first inspect the existing receipt and connected
catalog. Do not repair an unselected provider, create a profile, or rewrite
host configuration merely because a delegation skill was invoked. Prefer the
advertised `run_request` path; a catalog mismatch is a version issue, not a
reason to construct protected identities by hand.

Use the five MCP tools for delegation and lifecycle control.

1. Call `status` when provider or supervisor readiness is unknown. Prefer
   `detail: "compact", include_tasks: false` for a readiness-only check; use
   `refresh: true` only when an explicitly fresh probe is needed. Warm status
   is cache-backed and cold status may return `unknown/probing`. Require
   `local_boundary.ready: true` before local dispatch; local provider readiness
   is forced false when the boundary is unavailable.
2. Local dispatch requires Linux, a working `systemd --user` manager,
   `systemd-run` 244 or newer, and unified cgroup v2. `setup:check` checks
   CLI/worktree dependencies; `status`, dispatch preflight, and release/live
   acceptance validate the boundary from their actual MCP environment.
3. Choose `grok`, `cursor-local`, `cursor-cloud`, or `dsh`.
4. For a new bounded run, call `delegate` with the small semantic
   `run_request` body. The server derives the exact Git identity, manifest and
   prompt digests, provider model, child/workspace/dispatch identities, task
   IDs, and default managed-workspace policy. The argument shape is:

   ```json
   {
     "run_request": {
       "run_id": "auth-hardening",
       "repo": "/absolute/path/to/git-worktree",
       "objective": "Implement and review the auth hardening change.",
       "assignments": [
         {
           "assignment_id": "auth-implementation",
           "provider": "grok",
           "role": "implement",
           "access": "write",
           "prompt": "Implement the auth hardening slice and commit it.",
           "expected_duration_ms": 900000
         }
       ]
     }
   }
   ```

   Do not supply derived fields, hand-constructed digests, child IDs, or a
   manually assembled full `run` envelope. The full 3.4.0 `run` envelope
   remains accepted for compatibility, but skills do not construct it.

   Repository exposure uses the host's native MCP form. Only the user's
   accepted approval permits admission. If the receipt remains
   `awaiting_consent` after dismissal or interruption, continue the same run
   with `task` and `run_reply: {"request_consent": true}` to reopen the form.
   This requests a decision; it does not grant consent. Status and waits never
   reopen the form. Surface `consent_host_unavailable` as a host capability
   blocker; do not invent an `approval_ref` or switch launch paths to bypass it.

   Call `delegate` with a stable task ID for a legacy single task, the
   absolute Git worktree path in the property named `repo`, a clear prompt,
   and `expected_duration_ms` or a backwards-compatible `timeout_ms`. The
   argument shape is literal:

   ```json
   {
     "task_id": "review-auth-refactor",
     "provider": "grok",
     "repo": "/absolute/path/to/git-worktree",
     "prompt": "Review the current branch.",
     "expected_duration_ms": 600000
   }
   ```

   Do not rename `repo` to `git_root`, `repository`, or a prose description
   such as "Git root"; MCP schema validation rejects unknown properties. The
   recorded deadline is `ceil(expected_duration_ms * 1.20)` unless
   `timeout_ms` is an explicit override of at least that margin. Do not
   silently roll the deadline; extend it only with
   `extend_expected_duration_ms` and `extend_reason` before expiry, and only
   when the new deadline is strictly later.
5. Use `role: "review"` for analysis and `role: "implement"` for changes.
   DSH defaults to Muse Spark 1.3 Contributor. For the optional OpenRouter Ox
   Alpha route, keep `provider: "dsh"` and add
   `dsh_model: "stealth/ox-alpha"`. Never send its API key in the task.
6. For local tasks, use `workspace_mode: "managed"` by default. Use
   `workspace_mode: "direct"` only when direct mutation of the supplied
   checkout is intentional.
7. For Cursor Cloud, `repo` is still required and identifies the local clean
   checkout whose origin is sent to the provider. In addition, provide an
   exact immutable commit SHA in the Cursor Cloud-only `starting_ref`
   property; it must already be pushed to that provider-accessible origin.
   Before final acceptance, make a feature-branch SHA provider-visible through
   an open draft PR or the default branch. Treat an HTTP 400 for an otherwise
   valid SHA as a visibility failure; surface it in the receipt and fix
   reachability before retrying.
8. Set `create_pr` only for Cursor Cloud. Local tasks reject it; Codex
   decides whether local commits justify a PR after inspecting the handoff.
9. Coordinate without polling. For a bounded run use one run-scoped wait:
   `task` or `tasks` with `run_id`, `wait_until: "decision_or_attention"`,
   and the opaque run `cursor`. The adapter keeps legacy single-task and
   wait-any behavior available, but skills should use the run path for a
   bounded multi-lane submission. Routine progress does not wake the wait.
   For legacy tasks:
   - For one task, call `task` with `view: "compact"`. For a durable wait, add
     `wait_until: "terminal"` and the previous `event_cursor`. Optional
     `wait_ms` caps the call; omission follows the recorded deadline within the
     advertised pending-call budget.
   - For 2-8 independent tasks, call `tasks` once with `task_ids`, one shared
     `wait_ms`/`wait_until`, and the returned event `cursors` keyed by task ID.
     Do not mix wait-any properties with list filters or pagination properties;
     `cursor` is a list cursor, while `cursors` belongs to wait-any. Wait-any
     task snapshots and event previews are bounded; follow
     `progress.detail_hint` to the single-task call for full event detail.
   - Routine text does not wake terminal waits, and disconnecting a waiter does
     not stop provider work. Never replay an active or prompt-dispatched task.
     Unsolicited stdio callbacks across assistant turns are not available.
   - Inspect `view: "diagnostics"` only for needs-attention, failure, or a task
     that appears stuck. It is side-effect free and never waits. Deliver a
     same-session `reply` exactly once only when the capability allows it.
10. Capable clients default to structured-first bounded responses. Set
    `response_mode: "structured"` explicitly when the client advertises
    structured-content support. Legacy/text-only clients may omit it to retain
    the compatible full sanitized JSON text response. Compact status and run
    receipts are bounded by the server.
11. Use `cancel` for explicit cancellation or verified orphan recovery.
12. Inspect commits, handoff, and receipts before Codex merges anything.

Grok and Cursor Local use persistent ACP sessions. DSH uses the official rc.7
ACP composition through ACPX. Cursor Cloud uses the official Cursor SDK. A
local CLI fallback is allowed only when ACP fails before prompt dispatch. ACPX
does not provide an authoritative prompt-sent acknowledgement; after ACPX
spawns, DSH receipts say `dispatch_uncertain` and never fall back to CLI.
Explicit Ox Alpha tasks also fail closed before dispatch if ACPX cannot start,
because the DSH CLI fallback cannot prove that it preserves the selected model.

The manager-owned transient systemd user service used for local workers sets
`KillMode=control-group` only so cancellation reaches detached descendants and
workers survive the launching client. It is not a sandbox and
does not restrict environment, network, filesystem, credentials, or shell
capabilities. Local dispatch fails closed if the boundary is unavailable.

After a new run is admitted, the truthful public phase is `preparing` until
every required lane has authoritative `prompt_dispatched` evidence. Only then
may the UI or skill say that Co-Engineer is `running`.

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
