# Launch an installed Co-Engineer

Submit `delegate.run_request` once: a stable `run_id`, absolute Git `repo`,
`objective`, and one to eight `assignments`. Each assignment needs an
`assignment_id`, `role`, and `prompt`, plus either a chosen `provider` or a
matching explicit role preference. Optional
`expected_duration_ms` defaults to ten minutes, with the existing 20% deadline
margin; supply an estimate when the task needs a different duration.
State the requested output, allowed changes, tests and brief relevant evidence
in the prompt. Preserve repository instructions and required verification, but
do not ask the provider to duplicate machine-generated lifecycle or handoff receipts.
Reuse existing provider/model choices and supported provider preferences.
Delegate the complete bounded result, including its tests and corrections;
model overrides are optional. Preserve exact explicit selections.
The controller creates managed worktrees; the worker wrapper verifies them and
owns the writer lock and lifecycle. Do not ask the provider to reconstruct that
harness setup or supply its hidden writer token. The server derives identities
and defaults; do not construct the legacy full `run` envelope. Multiple writers
need disjoint `write_scope` paths. Dependent review starts after its input exists.

Use `run_request.preferences` to reuse the user's choices by role, for example
`{"implement":{"provider":"grok"},"review":{"provider":"cursor-local"}}`.
Assignment `provider` and `model` values take priority over matching preferences.
Preferences select owners for the supplied assignments; they do not create
dependent work or measure remaining subscription capacity. They are part of the
request, not a global Codex setting or a repository consent grant.

Keep the returned run ID and same run cursor. Wait through `task` with
`wait_until` set to `decision_or_attention`. Preparation and pending acknowledgement
are active work. On timeout or disconnect, reconnect to the same run; never replay
or submit a replacement. Routine progress stays internal.

Repository exposure uses the host's actual consent form. If interrupted, reopen
it with `task.run_reply.request_consent` on the same run. Never invent approval.
Answer actionable input through the returned reply identity. Unaffected work continues.

Inspect the returned candidate, concise handoff and decisive checks before
accepting it. Return a bounded correction to its external owner through the
supported revision action; do not rebuild its worktree, prompt or machine
receipts by hand. A new scoped revision must preserve its predecessor evidence.
Call `task` with the producer `run_id` and `revision` containing
`assignment_id`, `feedback`, `expected_head`, and `expected_idempotency_key`.
Copy the exact identity fields from the returned producer evidence. Follow the
new run ID and cursor; identical correction inputs must not dispatch twice.
Use `run_reply` only for actual pending questions or consent, not terminal fixes.
Required failures, uncertainty or unfinished cleanup block a verified result. Retrieve diagnostics
only for a concrete gap; use artifact references for omitted detail.

Admission checks readiness. Run compact `status` only to resolve an actual
readiness question. Setup, manual worktrees, extra coordinators, configuration
changes and repeated status checks are not launch prerequisites. Report a missing
capability or selected-provider prerequisite directly; do not reconfigure other
providers. Broader repair belongs to an explicit setup/debugging task.
