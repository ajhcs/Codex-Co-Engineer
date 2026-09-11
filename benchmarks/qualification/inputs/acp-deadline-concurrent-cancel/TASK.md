# ACP deadline extension and concurrent cancellation

This frozen case reproduces two public 3.4.2 defects later corrected in the
3.4.3 candidate: an in-flight ACP turn kept a fixed inner timeout that could
outlive a recorded deadline extension and then settle as a completed
`end_turn`, and overlapping turns shared cancellation so one session could
steal or drop another session's abort.

Repair `turn-runner.mjs` so the frozen checks in `turn-runner.test.mjs` pass.
Do not edit the test file, this prompt, or the recorded identity. Do not copy
later corrected sources into the workspace.

Required behavior:

- `extendDeadline` must refuse an empty reason, refuse a silent roll after the
  recorded deadline has already passed, and require the next deadline to be
  strictly later than the recorded one.
- An in-flight `runPromptTurn` is governed by the task's current deadline. An
  audited extension must re-arm that bound. Hitting the original inner timeout
  after a valid extension is not a successful completed turn.
- Timeout or interrupt after partial output remains timeout/cancelled. Partial
  text must not be promoted into `{ stopReason: 'end_turn' }`.
- Concurrent turns keep independent cancellation. Aborting turn A must not
  cancel turn B, and finishing A must not drop B's abort context.
- A pre-aborted signal fails as cancelled. A prompt that settles later must
  still be observed so it cannot become an unhandled rejection.

Acceptance is the frozen command `node --test turn-runner.test.mjs`.
