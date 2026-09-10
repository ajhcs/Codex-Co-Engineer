---
name: chat-with-co-engineer
description: Inspect, continue, answer grouped questions, or cancel an existing Co-Engineer run. Use for Chatting with Co-Engineer; never start new work.
---

# Chatting with Co-Engineer

Never start a run for unrelated work; continue the existing assignment. Codex remains
reviewer and merge authority. Use its returned identity to
inspect, continue, answer grouped attention, or cancel. If no run exists,
offer `$delegate-to-co-engineer`.

Wait through `task` with the run ID, `decision_or_attention`, and the same run
cursor. Routine progress needs no polling. On host timeout, reconnect to the same
run. Answer with `run_reply`; cancel with `cancel.run_id`. A side question does
not create a replacement assignment. For corrections to a completed candidate,
use `task.revision` with concise findings and the exact returned producer
identity. The [launch reference](../delegate-to-co-engineer/references/launch.md)
lists its fields.
Keep the original external provider/model and scope. A revision has a fresh
identity and preserves prior evidence; do not use an old attention reply or
replay an active/uncertain task. Return routine fixes to the external owner.

For interrupted repository consent, reopen the actual host form on the same run
with `run_reply.request_consent` set to true; this does not grant approval.
Group actionable questions. For example: `Co-Engineer needs one decision from you`.
Unaffected assignments continue. Inspect the result and relevant checks before
claiming verification; report any failure or unresolved work honestly.

Read [existing-run details](references/existing-run.md) only for an unfamiliar
reply or diagnostic operation. Raw lifecycle debugging uses
`$control-codex-co-engineer-agents`. Never ask the user to construct tool payloads.

For an explicitly requested legacy Luna/Sol relay, see [optional host relay](references/luna-pm-events.md). This is not required for ordinary delegation.

External workers may commit within their assigned scope. Publication and merge require user authorization and Codex review.
