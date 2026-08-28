# Existing-run procedures

Read only the section that matches the current request. Chatting never starts a second bounded run. Keep the same run cursor and the same `decision_or_attention` wait.

## Inspect or continue

User: Chatting with Co-Engineer: inspect the running work, then cancel it if it is stuck.

Inspect first. Cancel only that same run if it is stuck. Say that chatting inspects or cancels the existing run, and that another bounded run is not starting.

User: Chatting with Co-Engineer: continue and tell me when you have checked the candidate.

If the candidate is complete, inspect it, then say `Co-Engineer finished, and I verified the candidate. You still decide whether to keep, change, or discard it.` Do not claim a merge, push, or pull request.

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
