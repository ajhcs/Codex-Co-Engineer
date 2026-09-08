# Existing-run procedures

Read only the section that matches the current request. Chatting never starts a second bounded run. Keep the same run cursor and the same `decision_or_attention` wait.

## Inspect or continue

User: Chatting with Co-Engineer: inspect the running work, then cancel it if it is stuck.

Inspect first. Cancel only that same run if it is stuck. Say that chatting inspects or cancels the existing run, and that another bounded run is not starting.

User: Chatting with Co-Engineer: continue and tell me when you have checked the candidate.

If the candidate is complete, inspect it, then say `Co-Engineer finished, and I verified the candidate. You still decide whether to keep, change, or discard it.` That sentence is not itself a merge. External workers may commit. A scoped publisher may non-force push only the task branch and open a draft pull request. The PR-ready card reports exact HEAD and tree bound to current evidence, cleanliness including any in-progress Git operation, accepted required lanes, the open draft pull request's repository and host identity, and either the legacy `ready_for_sol_merge` readiness result or the exact blockers. That compatibility field does not select a model or grant authority. Codex remains the merge authority and may merge only after exact-head, current-green-CI, verifier, and topology checks and the user's authorization. The user retains release, tag, version, protected-ref, and product-policy authority.

## Grouped attention

The run is already in its one coordinated wait. More than one assignment needs a choice. Group those questions into one decision. Unaffected assignments keep working.

Codex: Co-Engineer needs one decision from you.

User: Use the stricter validator and keep the docs change as written.

Record that one decision and continue the same run. This is not a new delegation and not a debate loop.

## Failure or unresolved

User: Continue the running Co-Engineer work.

If a required assignment failed, cannot be answered, or stayed unresolved, report that gap. Do not say `Co-Engineer finished, and I verified the candidate.` Do not invent success, repair a lane in secret, or open a second run to hide the failure.

User: Cancel that run.

Cancel is chatting. Say the existing run was cancelled and that another one did not start.

## No run yet

If the user asks to chat and no run exists, say chatting needs existing work and offer `$delegate-to-co-engineer`. Do not silently submit.

## Luna Max project manager

If this run already has a pinned Luna Max thread, Codex calls send_message_to_thread and wait_threads on the bound threadId. A create_thread result with only clientThreadId is setup_pending; do not send or wait until the host supplies threadId and hostId. Wake it for completed, blocked, failed, question, timeout, or user_update. Routine progress does not wake it. A merge_ready envelope may wake Sol High or Sol XHigh once, and only when exact head and tree, verifier acceptance, current green CI, zero failed or hidden checks, and topology facts all pass. Do not invent cancel_thread. If create_thread, send_message_to_thread, and wait_threads or read_thread are missing, or Luna Max fails, stay in the current Codex task. I am not substituting Sol.
