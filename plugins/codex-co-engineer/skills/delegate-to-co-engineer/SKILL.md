---
name: delegate-to-co-engineer
description: Delegate complete implementation, investigation, or review assignments to authorized external co-engineers. Use for external capacity preferences and independent parallel work; use the chat skill to continue an existing assignment.
---

# Delegating to Co-Engineer

Give Codex a team of external co-engineers without giving up control.
The supported shape is up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Give an external co-engineer ownership of a bounded result, including relevant
preparation, implementation, meaningful checks, and requested corrections.
Codex remains chief engineer, reviewer, and merge authority.

When the user has authorized external work, delegate substantial independent
assignments before doing their implementation or routine verification yourself.
Use the user's provider preferences and available capabilities. If neither a named
provider nor a valid preference resolves selection, ask once among Grok, Cursor,
or Muse. Grok and Cursor
can own engineering decisions within their assignment; do not limit them to
mechanical edits or a second opinion. Keep tiny changes with the current owner
when delegation would cost more than it saves. No additional manager is required.

Read the short [launch path](references/launch.md) once, then reuse it.
Several named providers belong in one run with disjoint writers. A review of
new code starts after its exact candidate exists. Wait for a decision or actual
attention, and inspect concise results plus decisive evidence. Do not duplicate
the worker's exploration, recreate machine receipts, or read routine logs while
it works. Return bounded corrections to the same external owner.

For large autonomous tasks or reducing Astra coordination cost, use the
[ownership guide](references/autonomous-ownership.md). Read
[model guidance](references/model-roles.md) only when model selection matters.
Preserve explicit choices and host defaults; Co-Engineer does not change the
Codex model or reasoning effort. Missing provider capacity is not permission to
silently move the assignment into the native Codex pool.

For an explicitly requested legacy Luna/Sol relay, see the
[optional host relay](references/luna-pm.md). It is not a prerequisite.

Use concise, truthful updates. Examples: `I am delegating this to Co-Engineer`;
after actual verification, `Co-Engineer finished, and I verified the candidate.`
No fixed narration sequence is required. Claim running only after authoritative dispatch.
Provider completion is a candidate for review; unresolved required work prevents
verified completion. Existing work uses `$chat-with-co-engineer`; unfamiliar
runtime failures use `$control-codex-co-engineer-agents`.
Never ask the user to construct tool payloads.

External workers may commit within their assigned scope.
Publication and merge require user authorization and Codex review.
