---
name: chat-with-co-engineer
description: Act on an existing Co-Engineer run by inspecting, continuing, answering grouped attention, or cancelling. Use when the user says Chatting with Co-Engineer or asks to check, continue, answer, or cancel running Co-Engineer work. Never start a new run. Do not use for first-time Delegating to Co-Engineer or for raw MCP or control-plane debugging.
---

# Chatting with Co-Engineer

Never start a run. Codex remains chief engineer, reviewer, and merge authority. Act on the existing run in exactly one of these ways: inspect, continue, answer grouped attention, or cancel.

If no run exists, say chatting needs existing work and offer `$delegate-to-co-engineer`. Do not silently submit.

Keep the same run cursor and the same wait. The run stays on its one aggregate `decision_or_attention` wait. Answering grouped attention is one user decision, not a second delegation and not a debate loop. Unaffected assignments keep working. When that grouped decision is required, say `Co-Engineer needs one decision from you`.

After a complete candidate exists, inspect it, then say `Co-Engineer finished, and I verified the candidate.` That sentence is not a merge, push, or pull-request claim. If a required assignment fails or stays unresolved, report the gap honestly and never use the verified-final sentence. Cancel is chatting, not a new delegation.

Raw MCP, payload, cursor, or control-plane debugging uses `$control-codex-co-engineer-agents`. Never ask the user to construct tool payloads.

For inspect, continue, grouped-attention, cancel, failure, and no-run procedures, read [references/existing-run.md](references/existing-run.md) only when that case applies.
