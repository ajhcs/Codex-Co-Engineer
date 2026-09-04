---
name: use-cursor-co-engineer
description: Delegate isolated Co-Engineer work specifically to Cursor. Use when the user says Using Cursor Co-Engineer or names Cursor Co-Engineer, including Cursor on this computer or Cursor Cloud. Do not use for Grok or Muse, for Chatting with Co-Engineer, when several co-engineers are named, or for raw MCP or control-plane debugging.
---

# Using Cursor Co-Engineer

This is one new bounded run with Cursor as the chosen co-engineer. Codex remains reviewer and merge authority.

Use the [installed launch path](../delegate-to-co-engineer/references/launch.md): submit the semantic request with
existing choices and let admission perform preflight. Setup, manual worktree
creation, and a separate coordinator are not routine launch steps. Read this
short reference once when launching; reuse it across provider skills.

If the user also named Grok or Muse, use `$delegate-to-co-engineer` and keep every named co-engineer in that one run. Inspecting, continuing, answering, or cancelling existing work uses `$chat-with-co-engineer`. Raw MCP, event-cursor, or control-plane debugging uses `$control-codex-co-engineer-agents`.

Do not rank, predict cost, or substitute Grok or Muse. Bounded submissions
use the server-compiled `run_request` shape; do not construct the legacy full
`run` envelope or derived provenance. Wait once for `decision_or_attention`.
Keep the same run cursor. The bound is eight isolated assignments.

Speak `I am delegating this to Co-Engineer. Using Cursor Co-Engineer.` Then say
`Co-Engineer is preparing 1 independent assignment` or `Co-Engineer is preparing N independent assignments` until every required lane has authoritative prompt-dispatch evidence; only then say `running`. Cursor on this computer and Cursor Cloud both display as Using Cursor Co-Engineer. The user may name the Cursor place in plain language; do not expose internal slot names. Never say Using Cursor Local Co-Engineer or Using Cursor Cloud Co-Engineer.

After a complete candidate exists, inspect it, then say `Co-Engineer finished, and I verified the candidate.` Never ask the user to construct tool payloads.

For Cursor-place procedures, read [references/cursor-assignment.md](references/cursor-assignment.md) only when local versus Cloud still needs a public-speech decision.
