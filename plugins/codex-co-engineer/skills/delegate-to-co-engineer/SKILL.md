---
name: delegate-to-co-engineer
description: Start one new bounded Co-Engineer run of one to eight isolated independent assignments. Use when the user says Delegating to Co-Engineer, asks for a team of external co-engineers, or wants parallel independent assignments without naming a single co-engineer. Do not use to inspect, continue, answer grouped attention, or cancel an existing run, and do not use for raw MCP or control-plane debugging.
---

# Delegating to Co-Engineer

Start exactly one new bounded run. That is the only submission.

Give Codex a team of external co-engineers without giving up control. Codex remains chief engineer, reviewer, and merge authority. The substantiated shape is up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Use the [installed launch path](references/launch.md): submit the semantic request with
existing choices and let admission perform preflight. Setup, manual worktree
creation, and a separate coordinator are not routine launch steps. Read this
short reference once when launching; reuse it across provider skills.

## Route first

- Inspecting, continuing, answering grouped attention, or cancelling existing work uses `$chat-with-co-engineer`. Do not submit again.
- Exactly one named Grok, Cursor, or Muse Co-Engineer uses `$use-grok-co-engineer`, `$use-cursor-co-engineer`, or `$use-muse-co-engineer`.
- Several named co-engineers stay in this one run. Do not rank, predict cost, or substitute a different co-engineer.
- Reuse provider/profile choices already authorized in this task. If none exists, ask once among Grok, Cursor, or Muse before submission.
- Raw MCP, payload, cursor, or control-plane debugging uses `$control-codex-co-engineer-agents`.

Independent assignments do not share a writer path. The bound is eight. Wait once for `decision_or_attention`. Routine progress does not wake that wait. Keep the same run cursor.

Submit the semantic `run_request` shape and let the server compile all identities, provider defaults, task IDs, and workspace policy. Skills must not construct the legacy full `run` envelope or any derived provenance.

Speak `I am delegating this to Co-Engineer`, then `Co-Engineer is preparing 1 independent assignment` or `Co-Engineer is preparing N independent assignments` for N from 2 through 8. Say `Co-Engineer is running ...` only after the receipt proves authoritative `prompt_dispatched` evidence for every required lane. When a chosen co-engineer is actually used, also say `Using Grok Co-Engineer`, `Using Cursor Co-Engineer`, or `Using Muse Co-Engineer`. Cursor on this computer and Cursor Cloud both display as Using Cursor Co-Engineer. Never say Using DSH Co-Engineer, Using Ox Co-Engineer, Using Cursor Local Co-Engineer, or Using Cursor Cloud Co-Engineer.

After a complete candidate exists, inspect it, then say `Co-Engineer finished, and I verified the candidate.` That sentence is not a merge, push, or pull-request claim. Failure, cancel, and unresolved work must not use it.

Never ask the user to construct tool payloads.

For one-lane, multi-lane, ask-once, and provider-choice procedures, read [references/runs.md](references/runs.md) only when that case applies.

For a requested model hierarchy, read [model roles](references/model-roles.md).
Astra can own the chief role, Sol Medium can coordinate complex work, and Luna
can handle bounded native assignments alongside external workers. Sol High is
an optional combined chief/coordinator candidate, subject to evaluation.
Preserve explicit choices and stock defaults; do not create another task or
change global settings just to launch a Co-Engineer.
