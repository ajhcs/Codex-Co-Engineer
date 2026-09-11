# ACP deadline extension and concurrent cancellation

This retrospective task uses a bounded pre-fix snapshot of public repository
source. Repair the historical modules at their original paths so the frozen
checks in `checks/deadline-concurrent.test.mjs` pass.

Do not edit the check file, this prompt, or recorded identity. Do not copy
later corrected sources, Git history, or other trial outputs into the
workspace.

Required behavior:

- `nextDeadlineExtension` must refuse an empty reason, refuse a silent roll
  after the recorded deadline has already passed, and require the next
  deadline to be strictly later than the recorded one.
- An in-flight ACP turn is governed by the task's current deadline. An audited
  extension must re-arm that bound. Hitting the original inner timeout after a
  valid extension is not a successful completed turn.
- Timeout or interrupt after partial output remains timeout/cancelled. Partial
  text must not be promoted into a completed `end_turn`.
- Concurrent turns keep independent cancellation. Aborting turn A must not
  cancel turn B.
- A pre-aborted signal fails as cancelled.

Acceptance is the frozen command
`node --test checks/deadline-concurrent.test.mjs`.
