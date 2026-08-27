# Ask-once selection persistence (P27)

P27 is the closed pre-dispatch facade that persists one provider/model
selection question batch and accepts one complete structured reply. It sits
on accepted P05 resolution, the accepted R24A aggregate run anchor, and the
accepted R25B aggregate binding. It does not launch providers, open
workspaces, append P25 journal events, or emit P33 `AttentionBatchV1`.

## Boundary

- Inputs are a trusted `openAggregateRunAnchor(...)` handle plus strict
  direct-JSON immutable `manifest`, optional `profiles`, `availability`,
  `capabilities`, and `RunIdentityV1`.
- The run must already exist at R24A `submitted@0`. P27 never submits a
  run and never calls `commitResolvedPlan`.
- Direct-plan / no-question runs fail with typed `no_selection_required`.
- The derived `SelectionRequestV1` is the only persisted question. Assignment
  prompt prose is not copied into storage. The returned question is
  presentation data for Codex, not a runtime attention event.
- Crash and restart recompute P05 from the same immutable inputs and reuse
  only durable R24A records.

## Persist one question batch

`persistSelectionQuestionBatch(options)`:

1. Derives the exact P05 plan through `resolveRunSelectionV1`.
2. Requires an incomplete plan with one nonempty `SelectionRequestV1` of at
   most eight questions, then validates it with `validateSelectionRequestV1`
   / `selectionRequestIdentity`.
3. Checks the durable run identity against the supplied identity.
4. Persists exactly that record at `submitted@0` through
   `commitSelectionRequest` with the exact `run_id` / `request_id` / digest
   triple.

The first call returns `created: true`. An exact replay returns
`created: false` with a byte- and digest-identical question batch and no
revision growth. A different or stale manifest, snapshot, or request at the
same run fails closed. P27 never generates a second batch.

## Accept one structured reply

`acceptSelectionReply(options)`:

1. Re-derives the same outstanding request from the immutable P05 inputs.
2. Reads durable coordination first. The question must already be
   `awaiting_selection@1` with that exact binding; the reply path never
   creates the question.
3. Validates a dense plain JSON answer array: exactly one answer per
   question, no missing, extra, duplicate, or partial rows, and exact
   provider/model scope against the currently supplied availability and
   capability snapshots.
4. Re-resolves through `resolveSelectionAnswersV1` and requires a complete
   plan with unchanged snapshot digests.
5. Persists exactly one reply plus resolution through
   `commitSelectionResolution` at expected revision 1.

An identical reply replay is `created: false` and returns the same completed
in-memory plan and aggregate binding. Any different, stale, partial, or
duplicate reply during or after settlement fails closed with no mutation.

## Receipt

After a successful or identical resolution P27 calls accepted R25B
`bindAggregateResolution` and requires `resolution_ready` revision 2 before
returning. The receipt is detached and deeply frozen. It carries run and
request identity, digests, `disposition`, `created`, the completed in-memory
plan, and the aggregate binding. It never includes raw filesystem paths or
secrets.

Concurrent identical persist or reply calls converge to one durable record.
Concurrent different replies yield one winner and a deterministic typed
loser.

## Non-goals

- No provider, supervisor, workspace, or server transport.
- No P25 event kind, reducer, state, or cursor change.
- No P33 attention batch, sidecar, root adoption, or migration.
- No scheduler or public MCP API change.
