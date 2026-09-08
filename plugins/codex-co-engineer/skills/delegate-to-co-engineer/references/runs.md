# Delegation procedures

Read only the section that matches the current request. Users speak outcomes. Codex performs the one submission and the one `decision_or_attention` wait. Do not show tool payloads.

## One-lane

User: Review the auth change with Grok Co-Engineer.

This request named one co-engineer, so `$use-grok-co-engineer` owns it. If this skill is already loaded because the user said Delegating to Co-Engineer without a name, keep the assignment on the chosen co-engineer.

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer. Co-Engineer is preparing 1 independent assignment.

The card changes to running only after authoritative prompt-dispatch evidence exists for the required lane.

Wait once. When the work is complete, inspect it, then say `Co-Engineer finished, and I verified the candidate.` The user still decides whether to keep, change, or discard the result.

## Multi-lane

User: Split this into three isolated independent assignments: API validation, the operator guide, and a review of the existing authentication code.

Keep all three in this one run. A review of the two new diffs must follow their completion; it cannot run independently against a base that does not contain them. Do not start three runs and do not poll each assignment. Independent means the assignments do not share a writer path. Refuse a ninth assignment.

Codex: I am delegating this to Co-Engineer. Co-Engineer is preparing 3 independent assignments.

The card changes to running only after authoritative prompt-dispatch evidence exists for every required lane.

One `decision_or_attention` wait covers the whole run. Keep the same run cursor. When the run completes, inspect the combined result before any integration.

## Provider-choice

User: Use Grok Co-Engineer for the API change and Muse Co-Engineer for the docs. Keep the review on Cursor Co-Engineer.

Honor the named co-engineers in one run. Do not pick by cost, speed, or a hidden router. Cursor on this computer and Cursor Cloud both stay Using Cursor Co-Engineer in public speech.

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer. Using Muse Co-Engineer. Using Cursor Co-Engineer. Co-Engineer is preparing 3 independent assignments.

## No-profile ask-once

User: Give Codex a team of external co-engineers without giving up control. Split the validator and the docs.

If this task has no existing provider choice, ask once which co-engineers should take the independent assignments: Grok, Cursor, or Muse. Do not keep asking, invent a default router, or submit before the choice exists.

After the user answers, for example Grok for the validator and Muse for the docs:

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer. Using Muse Co-Engineer. Co-Engineer is preparing 2 independent assignments.

That is still one submission and one coordinated wait. The ask happens before delegation.

## After the wait

Continue, inspect, answer grouped attention, or cancel through `$chat-with-co-engineer` on this same run. Do not add a second submission. If Luna Max was pinned for this run, chatting messages that same host-bound project-manager thread.
