# Run scheduler (P33)

P33 `RunSchedulerV1` is the in-memory one-submission assignment fanout
boundary. It coordinates 1–8 independent lanes against one exact run/base
identity through injected task functions. It does not own durable storage,
artifacts, lifecycle proof, supervisor/server cutover, or candidate
composition.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-scheduler.mjs`
- `plugins/codex-co-engineer/test/r1-run-scheduler.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-scheduler-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-scheduler-fixtures.mjs`
- this document

## Factory

```js
createRunScheduler({ delegateTask, inspectTask, cancelTask, clock })
  -> { submitAssignments, resumeAssignments, cancelAssignments }
```

All four dependencies are required functions. The scheduler never imports
`run-runtime.mjs`, `run-artifact-bridge.mjs`, `acp-worker.mjs`,
`process-boundary.mjs`, `supervisor.mjs`, `server.mjs`, `task-store.mjs`,
mailbox, provider drivers, or candidate composers. Later run-runtime
composition injects these seams; tests inject scoped stubs.

`clock()` must return a UTC ISO-8601 timestamp or a safe epoch millisecond
count. Invalid clocks fail closed with a content-free `invalid_clock`.

## One-submission 1–8 fanout

`submitAssignments({ run_id, base_sha, assignments })` accepts 1–8
independent assignments that share one exact `run_id` and one exact 40-hex
`base_sha`.

Each assignment carries exact `assignment_id`, `task_id`, `role`, `access`,
`provider`, `model`, `write_scope`, and `required`. Cursor Cloud lanes also
pin `starting_ref`; local lanes must not.

The first exact body for a `run_id` is the only dispatch. Each lane is
handed to `delegateTask` at most once, concurrently, with an identity-only
plan (no prompt, argv, credentials, or workspace). Exact resubmit returns
the existing frozen receipt as `idempotent` and does not call `delegateTask`
again. A different body for the same `run_id` fails closed as
`scheduler_run_conflict` without a second dispatch.

A lane whose injected delegate fails or returns a mismatched `task_id`
becomes unresolved. Unaffected lanes continue. Required unresolved or
failed lanes set `complete_candidate_blocked`; optional/advisory lanes do
not.

## Disjoint writers and read-only verifiers

`implement` requires `access: "writer"` and a non-empty `write_scope`.
`review` and `verify` require `access: "read_only"` and an empty
`write_scope`. Overlapping writer scopes fail closed before any
`delegateTask` call. Read-only lanes do not participate in writer-scope
intersection.

## No fallback, replay, or duplicate dispatch

Replay, retry, fallback, dependency-edge, direct-mode, merge/push/create-PR,
executable, and credential keys are denied at any depth with the existing
precise codes. After a prompt-capable dispatch plan is handed to
`delegateTask`, that lane is never redispatched, never switched onto
another transport or model, and never retried from resume.

`resumeAssignments` inspects exact stored identities through `inspectTask`.
Cancelled lanes record `restart_denied_no_replay` and stay cancelled.
Cursor rows must bind the exact `assignment_id` and `task_id`.

## Cancellation, attention, and cursor evidence

`cancelAssignments({ run_id, assignment_ids })` requires exact known
assignment ids. Only those lanes are cancelled. Unaffected lanes continue.
An unconfirmed injected cancel records `safe_cancel_unconfirmed` and still
cancels remaining named lanes.

Resume projects bounded cursor and attention evidence. Routine progress
never wakes (`wake: false`). Grok and Cursor Local may carry
`same_session` attention. DSH and Cursor Cloud attention is
`unsupported`: the affected lane is safely cancelled and unresolved;
other lanes continue. Attention prompts are at most 4096 UTF-8 bytes;
options are at most eight.

Receipts are detached and deeply frozen. They never echo credentials,
paths, raw stub errors, or provider transcripts. Remote mutation stays
denied.

## API

- `createRunScheduler({ delegateTask, inspectTask, cancelTask, clock })`
- `submitAssignments(request)`
- `resumeAssignments(request)`
- `cancelAssignments(request)`
- `describeRunSchedulerV1()` — deterministic frozen inventory
- `RUN_SCHEDULER_SCHEMA_ID`, `RUN_SCHEDULER_VERSION`,
  `RUN_SCHEDULER_METHODS`, `RUN_SCHEDULER_CHECKS`,
  `RUN_SCHEDULER_ERROR_CODES`, `RUN_SCHEDULER_SIDE_EFFECTS`

Errors are typed `RunContractV1Error` values with content-free
diagnostics.

## Composition

| Surface | Owner | Use here |
| --- | --- | --- |
| 3.2.1 delegate / inspect / cancel | injected functions | called with exact run/assignment/task identity |
| P02 run/assignment identity and disjoint scopes | `run-manifest.mjs` | id grammar, SHA, writer-scope overlap |
| P03 canonical JSON | `identity.mjs` | submission digest |
| P24/P25/P34/runtime/artifact/lifecycle | later P33 runtime | not imported |
| Candidate composition | P35 | not imported |
| Server / supervisor cutover | R-CUTOVER | not imported |

## Non-goals

No durable journal or store. No workspace, branch, or ref creation. No
artifact capture. No lifecycle `/proc` or WTB lock inspection. No mailbox
delivery. No candidate ref. No MCP tool, supervisor cutover, CHANGELOG or
future-work edit, version bump, Gate A, release, merge, rebase, push, PR,
tag, or remote mutation.

## Testing

```
node --no-warnings --test test/r1-run-scheduler.test.mjs \
  test/r1-run-scheduler-adversarial.test.mjs
```
