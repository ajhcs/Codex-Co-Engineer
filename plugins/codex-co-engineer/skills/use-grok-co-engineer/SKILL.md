---
name: use-grok-co-engineer
description: Delegate isolated Co-Engineer work specifically to Grok. Use when the user says Using Grok Co-Engineer or names Grok Co-Engineer for an assignment. Do not use for Cursor or Muse, for Chatting with Co-Engineer, when several co-engineers are named, or for raw MCP or control-plane debugging.
---

# Using Grok Co-Engineer

This is one new bounded run with Grok as the chosen co-engineer. Codex remains reviewer and merge authority.

If the user also named Cursor or Muse, use `$delegate-to-co-engineer` and keep every named co-engineer in that one run. Inspecting, continuing, answering, or cancelling existing work uses `$chat-with-co-engineer`. Raw MCP or control-plane debugging uses `$control-codex-co-engineer-agents`.

Do not rank, predict cost, or substitute Cursor or Muse. Bounded submissions
use the server-compiled `run_request` shape; do not construct the legacy full
`run` envelope or derived provenance. Wait once for `decision_or_attention`.
Keep the same run cursor. The bound is eight isolated assignments.

Speak `I am delegating this to Co-Engineer. Using Grok Co-Engineer.` Then say
`Co-Engineer is preparing 1 independent assignment` or `Co-Engineer is preparing N independent assignments` until every required lane has authoritative prompt-dispatch evidence; only then say `running`. Never say Using DSH Co-Engineer or Using Ox Co-Engineer.

After a complete candidate exists, inspect it, then say `Co-Engineer finished, and I verified the candidate.` Never ask the user to construct tool payloads.

For one-lane Grok procedures, read [references/grok-assignment.md](references/grok-assignment.md) only when the assignment shape is not already explicit.
