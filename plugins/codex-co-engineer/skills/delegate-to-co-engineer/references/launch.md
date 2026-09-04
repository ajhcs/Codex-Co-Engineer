# Launch an installed Co-Engineer

Use this path for a new assignment. Installation, provider authentication, and
host configuration are separate setup tasks. A ready deployment needs one
semantic submission and one coordinated wait.

1. Reuse the provider, model override, profile choice, and Cursor location
   already given in this task. Ask once only when a consequential choice is
   still missing. Do not ask again because another skill became active.
2. Submit `delegate` with `run_request`: `run_id`, absolute `repo`, `objective`,
   and one to eight `assignments`. Each assignment needs `assignment_id`,
   `provider`, `role`, `prompt`, and `expected_duration_ms`. Access is derived
   from role: `review` and `verify` are read-only; `implement` is a writer.
   Multiple writers each need an explicit disjoint `write_scope`; use the
   task's bounded scope for a single writer too. The server supplies model
   defaults when `model` is omitted and derives identities, digests, task IDs,
   and workspace policy. Do not create a profile, manually bootstrap a
   worktree, or generate the legacy `run` envelope to fill those defaults.
3. Follow the admission receipt. A preparing or validating run is already
   accepted work: retain its `run_id`. Wait through `task` with that `run_id`,
   `wait_until: "decision_or_attention"`, and the returned cursor. On host
   timeout, reconnect to that same run. Never submit a replacement because
   a response was slow, partial, or disconnected.
4. Repository exposure uses the host's native approval form. The user accepts
   or declines the actual repository/provider scope there. If the host cannot
   show the form, report the capability blocker. To reopen an interrupted
   decision, use the same run with `run_reply: { "request_consent": true }`;
   do not resubmit or invent an `approval_ref`. Inspecting or waiting does not
   request approval again. Continue unaffected work while input is pending.
5. Inspect the combined diff and relevant checks before accepting the result.
   Required lanes that failed or remain unresolved prevent a verified result.

Check `status` with `detail: "compact", include_tasks: false` only when
readiness is unknown and needed to choose a path, or when dispatch reports a
readiness failure. Successful admission already performs its own checks.
A known ready provider does not need repeated readiness probes. An unavailable
unselected provider is not a reason to configure the whole installation.

For a real setup failure, identify the selected provider and exact failed
prerequisite. Reuse existing configuration. Do not reinstall dependencies,
rewrite MCP settings, create credentials, or run release qualification as a
routine launch step. If the required `run_request` capability is missing from
the connected catalog, report the version mismatch; do not reverse-engineer
private modules or fabricate protected metadata. Broader repair belongs to an
explicit setup/debugging request.

State the outcome, relevant base/files, allowed edits, and acceptance checks
in each prompt. Workers can choose their implementation steps. Keep one owner
for dependent integration; a review of newly produced diffs starts after
those diffs exist. Parallel review can inspect the existing base instead.
Do not assign one writer path twice or duplicate work through native agents.
A coordinator or pinned sidebar task is optional and never a launch prerequisite.
