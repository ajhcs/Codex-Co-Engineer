# Launch an installed Co-Engineer

Submit `delegate.run_request` once: a stable `run_id`, absolute Git `repo`,
`objective`, and one to eight `assignments`. Each assignment needs an
`assignment_id`, chosen `provider`, `role`, `prompt`, and `expected_duration_ms`.
State the outcome, allowed changes and acceptance checks in the prompt.
Reuse existing provider/model choices. Model overrides are optional.
The server derives identities, defaults and isolated workspaces; do not construct
the legacy full `run` envelope. Multiple writers need disjoint `write_scope` paths.
Dependent review starts after its input exists.

Keep the returned run ID and same run cursor. Wait through `task` with
`wait_until` set to `decision_or_attention`. Preparation and pending acknowledgement
are active work. On timeout or disconnect, reconnect to the same run; never replay
or submit a replacement. Routine progress stays internal.

Repository exposure uses the host's actual consent form. If interrupted, reopen
it with `task.run_reply.request_consent` on the same run. Never invent approval.
Answer actionable input through the returned reply identity. Unaffected work continues.

Inspect results, changes and checks before accepting them. Required failures,
uncertainty or unfinished cleanup block a verified result. Retrieve diagnostics
only for a concrete gap; use artifact references for omitted detail.

Admission checks readiness. Run compact `status` only to resolve an actual
readiness question. Setup, manual worktrees, extra coordinators, configuration
changes and repeated status checks are not launch prerequisites. Report a missing
capability or selected-provider prerequisite directly; do not reconfigure other
providers. Broader repair belongs to an explicit setup/debugging task.
