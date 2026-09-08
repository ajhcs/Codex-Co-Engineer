# Luna Max event relay

Read this only when chatting on an existing Co-Engineer run that has, or
should have, a Luna Max project manager. Chatting still never starts a
second bounded run. Keep the same run cursor and the same
`decision_or_attention` wait. Co-Engineer MCP cannot invoke host-only
Codex task tools and must not add a sixth tool to simulate the Desktop
host. Codex is the host executor. The JS adapter only plans and validates
call shapes; it does not invoke host callbacks. The Co-Engineer event
store remains source of truth.

If the pinned Luna Max thread exists, bind the actual host `threadId`
and `hostId` and message it with `send_message_to_thread` using a real
prompt body. Wait with `wait_threads` targets that MUST include
`threadId` and MAY include `hostId` and `afterCursor`, plus a bounded
timeout, or `read_thread`. A `create_thread` result with only
`clientThreadId` is `setup_pending`; do not send or wait until the host
supplies `threadId` and `hostId`. Optionally `set_thread_archived` or
`set_thread_pinned` when those tools exist. Do not invent
`cancel_thread`, `archive_thread`, or `pin_thread`. The host has no
cancel primitive, so do not claim cancellation support. If
`create_thread`, `send_message_to_thread`, and `wait_threads` or
`read_thread` are missing, or Luna Max fails, stay in the current Codex
task and say that Luna Max project-manager messaging is unavailable. I
am not substituting Sol. Do not invent `resume_task`.

Wake Luna Max for completed, blocked, failed, question, timeout, or
user_update. Routine progress does not wake a model. Bind each envelope
to exact identity: message id, run id, assignment id when applicable,
attempt id, from and to task ids, parent or reply, correlation id, kind,
generation, event cursor, created-at, payload digest, and a bounded
event summary or artifact_ref. Ignore stale generation, stale attempt,
or duplicate message ids. Reject a message for the wrong thread or run.
Grouped attention must preserve and validate a bounded identity/routing
tuple for every question_id: task_id, assignment_id, session_id,
question identity, attempt, generation, and correlation or digest. Route
one structured response covering all answerable questions exactly once.
Do not alias the group to a single question_id.

Sol Medium is not a mandatory layer. Normal completion does not wake
Sol. A distinct `merge_ready` envelope may wake Sol High or Sol XHigh
exactly once for final integration, and only when exact head and tree,
verifier acceptance, current green CI, zero failed or hidden checks, and
topology facts all pass. Sol High or Sol XHigh may also adjudicate
conflicting exact evidence or reviewer verdicts, security or
protected-ref risk, composition ambiguity, repeated deterministic
rejection, a release-authority decision, or explicit user escalation.
Only Luna's parent project-manager task may terminalize work for Sol.

Forward bounded sanitized evidence references only. Auto-spill over-bound
bodies to artifact references. Do not send raw transcripts or secrets.
Luna native subagents stay local analysis, inherit capabilities, stay
at depth at most 2, and must not duplicate a Co-Engineer external writer
assignment. External workers may commit. A scoped publisher may non-force push
the task-owned unprotected Codex branch and open or update a draft pull
request. Sol High or Sol XHigh alone performs regular merge after
deterministic exact-head, current-green-CI, and topology checks. The
user retains release, tag, version, and protected-ref authority. No
worker or message can force-push, merge, rebase, tag, release, delete
refs, or override verification. Luna does not merge.

The shared TaskPort policy is
[../../delegate-to-co-engineer/references/luna-pm-relay.mjs](../../delegate-to-co-engineer/references/luna-pm-relay.mjs).
The runtime host adapter is
[`../../../mcp/v3/luna-pm-host-adapter.mjs`](../../../mcp/v3/luna-pm-host-adapter.mjs).
