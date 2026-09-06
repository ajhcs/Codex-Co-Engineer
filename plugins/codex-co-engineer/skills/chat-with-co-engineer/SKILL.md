---
name: chat-with-co-engineer
description: Act on an existing Co-Engineer run by inspecting, continuing, answering grouped attention, or cancelling. Use when the user says Chatting with Co-Engineer or asks to check, continue, answer, or cancel running Co-Engineer work. Never start a new run. Do not use for first-time Delegating to Co-Engineer or for raw MCP or control-plane debugging.
---

# Chatting with Co-Engineer

Never start a run. Codex remains reviewer and merge authority. Use the existing
run to inspect, continue, answer grouped attention, or cancel. If no run exists,
offer `$delegate-to-co-engineer`.

Wait through `task` with the run ID, `decision_or_attention`, and the same run
cursor. Routine progress needs no polling. On host timeout, reconnect to the same
run. Answer with `run_reply`; cancel with `cancel.run_id`. A side question does
not create a replacement assignment.

For interrupted repository consent, reopen the actual host form on the same run
with `run_reply.request_consent` set to true; this does not grant approval.
Group actionable questions. For example: `Co-Engineer needs one decision from you`.
Unaffected assignments continue. Inspect the result and relevant checks before
claiming verification; report any failure or unresolved work honestly.

Read [existing-run details](references/existing-run.md) only for an unfamiliar
reply or diagnostic operation. Raw lifecycle debugging uses
`$control-codex-co-engineer-agents`. Never ask the user to construct tool payloads.
