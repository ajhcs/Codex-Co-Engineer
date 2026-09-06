---
name: delegate-to-co-engineer
description: Start one new bounded Co-Engineer run of one to eight isolated independent assignments. Use when the user says Delegating to Co-Engineer, asks for a team of external co-engineers, or wants parallel independent assignments without naming a single co-engineer. Do not use to inspect, continue, answer grouped attention, or cancel an existing run, and do not use for raw MCP or control-plane debugging.
---

# Delegating to Co-Engineer

Give Codex a team of external co-engineers without giving up control.
Codex remains chief engineer, reviewer, and merge authority. The supported shape
is up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Read the short [launch path](references/launch.md) once, then reuse it.
Reuse authorized provider choices; if missing, ask once among Grok, Cursor, or Muse.
Keep several named providers in one run. Existing work uses
`$chat-with-co-engineer`; raw lifecycle debugging uses
`$control-codex-co-engineer-agents`.

Use natural, concise updates. For example: `I am delegating this to Co-Engineer`.
Describe preparation honestly; claim running only with authoritative dispatch.
After inspecting a complete candidate, you may say
`Co-Engineer finished, and I verified the candidate.` Report failures and gaps
instead when work is incomplete. No fixed narration sequence is required.
Never ask the user to construct tool payloads.

Read [model guidance](references/model-roles.md) only when choosing models is
part of the task; a separate coordinator is optional.
