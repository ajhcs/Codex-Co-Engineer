# Luna Max project manager

Read this only when starting or continuing a bounded Co-Engineer run. The
five public skills stay Delegating, Chatting, Grok, Cursor, and Muse.
Luna Max is not a sixth public skill.

The Co-Engineer run/event transport stays the only submission path. Wait
once for `decision_or_attention`. Keep the same run cursor. That transport
does not poll models. Co-Engineer MCP cannot invoke host-only Codex task
tools and must not add a sixth tool to simulate the Desktop host. The
skill is the host executor. The JS adapter in
`mcp/v3/luna-pm-host-adapter.mjs` is a deterministic request/validation
layer; it does not invoke host callbacks. The Co-Engineer event store
remains source of truth.

## Skill guarantee versus host capability

This skill can guarantee the policy below. It cannot create Codex Desktop
task threads by itself. Codex calls the real host tools. The adapter
plans and validates those call shapes; it does not invent extra ones.

Host-dependent Codex Desktop task-management, when present, is feature
detected as `create_thread`, `send_message_to_thread`, and
`wait_threads` or `read_thread`. Optionally `set_thread_archived` or
`set_thread_pinned` when those tools exist. A usable `create_thread`
result includes `threadId` and `hostId`. A result that contains only
`clientThreadId` is `setup_pending` / resume-needed: do not send or
wait until the host supplies a real `threadId` and `hostId`.
`wait_threads` targets MUST include `threadId` and MAY include `hostId`
and `afterCursor`, plus a bounded timeout.
`send_message_to_thread` requires `threadId` plus a real prompt body.
Do not invent `create_task`, `resume_task`, `cancel_thread`,
`archive_thread`, or `pin_thread`. The host has no cancel primitive, so
do not claim cancellation support. Bind only the actual thread id, host
id, and cursor the host returns.

If those tools are missing, or Luna Max is missing, unauthorized, or
fails, continue in the current Codex task and say that Luna Max
project-manager messaging is unavailable. I am not substituting Sol. Do
not invent another model.

## Pin the default project manager

When the user authorizes it and Luna Max is actually available and the
host tools exist, pin one Luna Max task as the default routine project
manager for this run. After `create_thread`, bind a usable `threadId`
and `hostId`. Message that same thread later. Do not start a second
Co-Engineer submission to get a manager.

## Exact Codex Desktop host-tool sequence

Codex, not the JS adapter and not a sixth Co-Engineer MCP tool, executes
this sequence when the host tools exist:

1. Feature-detect `create_thread`, `send_message_to_thread`, and
   `wait_threads` or `read_thread`. Optionally `set_thread_archived`
   and `set_thread_pinned`.
2. Call `create_thread` with `{ model }`.
3. If the result contains only `clientThreadId`, treat it as
   `setup_pending` / resume-needed. Do not call
   `send_message_to_thread` or `wait_threads`. Resume when the host
   supplies a real `threadId` and `hostId`.
4. If the result includes `threadId` and `hostId`, bind those. Cursor
   is optional.
5. Optionally call `set_thread_pinned` with `{ threadId, pinned: true }`.
6. Call `send_message_to_thread` with `{ threadId, prompt }` and a real
   prompt body.
7. Call `wait_threads` with
   `{ targets: [{ threadId, hostId?, afterCursor? }], timeoutMs }`
   where every target MUST include `threadId` and MAY include `hostId`
   and `afterCursor`. Or call `read_thread` with
   `{ threadId, afterCursor }` when that wait tool is the one present.
8. Optionally call `set_thread_archived` with `{ threadId, archived }`.

Preserve explicit user model overrides and the named Grok, Cursor, or
Muse co-engineers. Sol Medium is not a mandatory layer and must not
become the default manager. Sol High or Sol XHigh is the merge actor
for a verified `merge_ready` packet and an on-demand exception
adjudicator.

Luna may use native read-only analysis subagents with inherited
capabilities. Depth from the root is at most 2. Their descendant budget
counts against the existing 8-lane ceiling. They must not take a writer
path already assigned to a Co-Engineer external writer or widen
provider, filesystem, Git, or merge authority. Only Luna's parent
project-manager task may reply to or terminalize work for Sol.

## Events that wake Luna Max

Wake the pinned Luna Max task on completed, blocked, failed, question,
timeout, or user_update envelopes. Routine progress does not wake it. A
distinct `merge_ready` envelope may wake Sol High or Sol XHigh exactly
once, and only when exact head and tree, verifier acceptance, current
green CI, zero failed or hidden checks, and topology facts all pass.
Normal lane completion stays with Luna Max.

Each envelope carries message id, run id, assignment id when applicable,
attempt id, from and to task ids, parent or reply id when applicable,
correlation id, kind, generation, event cursor, created-at,
payload digest, and a bounded event summary or artifact_ref. Persist by
append, cursor, and dedupe. A stale generation or attempt cannot settle
current work. Auto-spill bodies above the bound to an artifact
reference. Do not serialize an unbounded seen-event list.

Grouped attention is a `question` envelope. It must preserve and
validate a bounded identity/routing tuple for every question_id:
task_id, assignment_id, session_id, question identity, attempt,
generation, and correlation or digest. Route one structured response
covering all answerable questions exactly once. Do not alias the group
to a single question_id.

The event summary is compact assignment state, grouped question identity,
unresolved reason, deadline, candidate head and tree, and CI or
verification facts when merge-ready.

## Sol, publisher, and merge

Normal completion never wakes Sol. A verified publication-ready packet
may wake Sol High or Sol XHigh once. Escalate otherwise only for
conflicting exact evidence or reviewer verdicts, security or
protected-ref risk, composition ambiguity, repeated deterministic
rejection, a release-authority decision, or explicit user escalation.

External workers may commit in their managed worktree. A scoped
publisher may non-force push only the exact task-owned unprotected Codex
branch and open or update its draft pull request after the user
authorized publication. Sol High or Sol XHigh alone performs regular
merge after deterministic exact-head, current-green-CI, and topology
checks. The user retains release, tag, version, and protected-ref
authority. Luna may request readiness or publishing and does not merge.
No worker or message can force-push, merge, rebase, tag, release,
delete refs, or override verification. Identity drift fails closed back
to Luna.

The executable TaskPort policy is [luna-pm-relay.mjs](luna-pm-relay.mjs).
The runtime host adapter is
[`../../../mcp/v3/luna-pm-host-adapter.mjs`](../../../mcp/v3/luna-pm-host-adapter.mjs).
