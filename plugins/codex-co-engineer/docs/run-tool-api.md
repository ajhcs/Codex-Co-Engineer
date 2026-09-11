# Run tool API

The 3.4.3 additions are role preferences, candidate revisions, and
compact result/usage evidence. Published 3.4.2 does not expose those additions.

Co-Engineer keeps the five-tool MCP catalog. Submit, status, wait, attention,
reply, cancel, and cleanup are parameters and modes on `status`, `delegate`,
`task`, `tasks`, and `cancel`. The preferred bounded-run ingress is the small
server-compiled `run_request`; the 3.4.0 full `run` envelope remains accepted
for compatibility and is not constructed by the skills.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-tool-adapter.mjs`
- `plugins/codex-co-engineer/mcp/v3/server.mjs`
- `plugins/codex-co-engineer/mcp/v3/supervisor.mjs`
- `plugins/codex-co-engineer/test/r1-run-tool-adapter.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-tool-adapter-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-tool-adapter-fixtures.mjs`
- this document

## Catalog

The public catalog remains exactly:

`status`, `delegate`, `task`, `tasks`, `cancel`

Omitted additive fields preserve exact 3.2.1 direct/single-task/full-text/
structured/wait/diagnostic/reply/cancel behavior and response shapes.

## Frozen mapping

| Operation | Tool | Additive parameter or mode |
| --- | --- | --- |
| submit | `delegate` | `run_request` (preferred), `run` (legacy compatibility) |
| status | `status` or `task` | `run_id` |
| wait | `task` or `tasks` | `run_id` plus `wait_until: "decision_or_attention"` |
| attention | `task` | `run_id` plus `attention` |
| reply | `task` | `run_id` plus `run_reply` |
| revision | `task` | `run_id` plus `revision` |
| cancel | `cancel` | `run_id` plus optional `assignment_ids` |
| cleanup | `cancel` | `run_id` plus `cleanup: true` |

`wait_until` remains `progress` and `terminal` for 3.2.1. The additive
run mode is `decision_or_attention`. Routine progress never wakes.

`task.revision` derives a new bounded correction from a completed, clean,
exactly identified producer assignment. It preserves provider, model, write
scope, access, capabilities, and the original assignment constraints for a
fresh worker, plus correction feedback and the reviewed HEAD. If the combined
prompt cannot fit the existing 16,384-byte bound, `bounded_context_overflow`
rejects it before dispatch; constraints are never silently clipped. Public
admission receipts and the compact coordination packet return the producer
request identity (`request_idempotency_key`) and unambiguous per-assignment
HEAD/status. Completed candidates next-action to `review`; `revision` is an
available capability for a proven clean completed writer. The coordinator
decides whether findings warrant using it; provider prose does not make that decision. Completed-but-dirty,
uncertain, or cleanup-incomplete evidence stays unresolved. Active,
uncertain, dirty, stale, missing, remote, or unfinal producers fail closed
and are never replayed. Duplicate calls with the same identity, including
concurrent duplicates, dispatch once. Compact packets include retrievable
artifact refs when those artifacts exist; identity hashes are not presented
as retrievable artifacts.

The correction chain has a fixed limit of three admitted rounds and one
distinct child per producer. The child retains original and immediate producer
identity, `round`, and `limit`. Repeated identical requests follow that child;
different feedback is rejected with `revision_child_exists` and the child id,
explicitly stating that the new feedback was not applied. An admitted
failure does not replenish a consumed round. `revision_budget_exhausted` requires
a deliberate new bounded assignment and never dispatches it automatically.
The production store reserves that child exclusively across MCP processes.
If a crash leaves a reservation without a child receipt, the operation returns
`revision_admission_pending`. Inspect the retained state; no automatic replay or
budget replenishment follows. A deliberate new bounded assignment is a separate
decision and is not a recovery claim that earlier work never ran.

Normal run replies also contain `result_evidence`; `view: "diagnostics"` requests
its detailed outcome and usage view. It uses the existing ledger and local
decision card. Completion is not Codex acceptance; unknown usage stays unknown.
See [run results](run-results.md) for measurement scope and limits.

Mixing a run body with 3.2.1 `task_id` / `workspace_mode` / `create_pr` /
`reply` fields fails closed.

## Simple run request

Call `delegate` with only semantic intent:

```json
{
  "run_request": {
    "run_id": "vale-hardening",
    "repo": "/absolute/repository/path",
    "objective": "Implement and review the hardening plan.",
    "assignments": [
      {
        "assignment_id": "social-implementation",
        "provider": "grok",
        "role": "implement",
        "prompt": "Implement the social ingestion slice.",
        "expected_duration_ms": 900000
      }
    ]
  }
}
```

Assignment `access` is optional: `implement` derives `writer`, while `review`
and `verify` derive `read_only`. An explicit value must agree with the role.
Omitting access and supplying its equivalent explicit value produce the same
normalized request. Multiple writer lanes need explicit disjoint write scopes.

Optional `preferences` reuse provider ownership by role so eligible
assignments may omit `provider` / `model`. Exact assignment selections win,
including when they override an unknown role preference. Unknown or
unavailable preferred providers are reported only when an assignment would
use them; unused unknown role preferences do not block dispatch. Used
unknown preferences return a pre-admission result with no persisted run and
`next_action=resubmit` instead of a fake identity that asks for `reply`.
Omitted preferences keep the explicit provider path unchanged.

```json
{
  "run_request": {
    "run_id": "vale-hardening",
    "repo": "/absolute/repository/path",
    "objective": "Implement and review the hardening plan.",
    "preferences": {
      "implement": { "provider": "grok" },
      "review": { "provider": "cursor-local" }
    },
    "assignments": [
      {
        "assignment_id": "social-implementation",
        "role": "implement",
        "prompt": "Implement the social ingestion slice."
      }
    ]
  }
}
```

The server observes the clean exact Git identity, resolves the provider model,
and derives the request idempotency key, manifest/prompt-envelope/lane
digests, child and task identities, and managed-workspace policy. Callers
cannot provide those derived fields. A changed objective, assignment,
provider, SHA, or scope produces a different identity.

The stdio server requests repository exposure through the host's native MCP
form. The form names the repository/base, run, and selected providers. Native
**Accept** is the approval; there is no second approval checkbox. The required
selector clearly defaults to remembering approval for the canonical Git
repository and exactly those providers, with **This run only** as the one-time
choice. A remembered provider subset can be reused across worktrees that share
the same Git common directory. A new provider, changed origin, unrelated or
recreated repository, rejected form, or malformed owner state cannot reuse it.
No earlier run-only approval is migrated. A model-authored boolean or prose
reply does not approve access. Hosts without form elicitation return an
explicit capability blocker before any workspace or prompt dispatch.

Remembered grants live in the owner-only Co-Engineer state directory and never
contain credentials. Inspect or revoke them with the installed package command:

```sh
node /absolute/path/to/plugin/bin/consent-grants.mjs list
node /absolute/path/to/plugin/bin/consent-grants.mjs revoke --repo /absolute/path/to/repository
node /absolute/path/to/plugin/bin/consent-grants.mjs revoke --grant-id GRANT_ID_FROM_LIST
```

An npm package installation also provides the shorter
`codex-co-engineer-consent` command. If a process stops during a grant update
and later commands report `consent_grant_store_busy`, first verify that no MCP
server or consent command is running, then remove only
`.consent-grants.lock` from the owner-only Co-Engineer state directory.

A dismissed or interrupted approval remains inspectable. To request the
native form again for a pending run, call `task` with the same `run_id` and
`run_reply: { "request_consent": true }`. This requests a decision; it is not
approval. Ordinary status and wait calls never reopen the form. The existing
opaque `approval_ref` continuation remains available to embedding hosts with
a trusted verifier; ordinary stdio clients do not construct these references.

Admission has two barriers. The server validates consent, provider and local
boundary readiness, repository identity, every workspace, and disjoint writer
scope before sending any prompt. Pending consent is shown as attention; workspace admission is
`preparing`. The run can say `running` only when every required lane has
authoritative `prompt_dispatched` evidence. A mid-dispatch failure is
`degraded` with exact dispatched, undispatched, and uncertain lane lists.

Run and lane phases are explicit and receipts are restartable. Prompt-dispatch
uncertainty is never replayed. Post-prompt unrecoverable work produces a
bounded partial handoff with the retained worktree, starting/current SHA,
clean state, changed files, commits, last provider event, recovery class, and
safe next actions.

## Bounds and selection

One run submission carries 1–8 lanes. Provider/model is explicit on each
assignment or filled from one named profile. Explicit fields must agree
with that profile when both are present; omitted fields may be filled
from the profile. A missing, invalid, or conflicting profile fails
closed before dispatch. The adapter never learns, ranks, or globally
routes. The accepted four-slot registry is `grok`, `cursor-local`,
`cursor-cloud`, and `dsh`. P22 future-harness conformance remains
evidence, never a provider slot.

Direct mode, replay, fallback, merge, push, create-PR, GitHub, and
remote keys fail before any provider dispatch, ref creation, or cleanup.

## Authority preserved

| Surface | Owner | Use here |
| --- | --- | --- |
| One-submission runtime, proof-bound cleanup, lifecycle finality | P33 | injected `submitRun` / `inspectRun` / `resumeRun` / `cancelRun` |
| Attention latch and exactly-once reply | P34 | `resumeRun` attention items and injected `attention.reply` |
| Run-owned candidate ref | P35 | projected `refs/codex-co-engineer/runs/<run-id>/candidate`; never composed here |
| Four-slot provider composition | P23 | exact `{provider, model}` lookup; no fallback |
| Terminal false-success projection | R-TRUTH | model-facing lane receipts |
| Remote mutation denial | P29 / P28 | `denyRunToolRemoteMutationV1` |

Unaffected lanes continue. A required unresolved lane blocks a complete
candidate. Decision results are the verified P33/P34 receipts, not caller
prose. MCP output is model-facing: owner-only raw artifacts are stripped.

Production default seams are durable P24/P25/P34/P32 authorities under
the supervisor state root (`runs/store`, `runs/journal`,
`runs/attention`, `runs/scheduler`, `runs/artifacts`). Tests may inject
`createInProcessRunSeams` or an explicit `seams` object. Restart
recovery, journal cursors, attention CAS, scheduler-plan identity, and
proof-bound cleanup are not process-local Maps.

Production `attention.reply` binds P34 to the supervisor proof-bound
same-session mailbox (`submitReply`): the one reply round must match the
latched task/session/question identity and is delivered exactly once.
Failed or unconfirmed cancellation stays unresolved/unsafe, including
after durable restart, and never projects cancelled/safe. Authoritative
artifact bytes and scheduler-plan identity persist before or atomically
with provider dispatch; stale, partial, or mismatched state fails closed
and never duplicates dispatch. One immutable run-level profile/catalog
snapshot is loaded, bound, and persisted at submit; later catalog
mutation cannot change assignment resolution.

`wait_until: "decision_or_attention"` performs a bounded wait
(`wait_ms` 0 is a snapshot; omit follows the MCP pending-call budget).
It wakes only on attention or terminal lane decisions, keeps the last
lane cursor, and never replays. Model-facing receipts recursively strip
owner-only `raw` / `bytes` / `secret` evidence. Attention items are
validated before any scheduler resume.

## API

- `classifyRunToolCall(tool, args)` — pure; `legacy` or `run`
- `createRunToolAdapter({ runtime, attention?, projectLaneTask?, classifyLaneTask?, rememberSubmitContext? })`
- `createDurableRunSeams({ root, delegateTask, inspectTask, cancelTask, settleLocalTaskLifecycle, cleanupLocalTaskLifecycle, clock? })`
- `createInProcessRunSeams({ delegateTask, inspectTask, cancelTask, settleLocalTaskLifecycle, cleanupLocalTaskLifecycle, clock? })`
- `describeRunToolAdapterV1()`
- `denyRunToolRemoteMutationV1(operation)`

## Testing

```
node --no-warnings --test test/r1-run-tool-adapter.test.mjs \
  test/r1-run-tool-adapter-adversarial.test.mjs \
  test/v3-server.test.mjs \
  test/v3-supervisor.test.mjs
```
