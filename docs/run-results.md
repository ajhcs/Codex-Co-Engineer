# Understand a Co-Engineer result

In 3.4.3, ordinary run replies include a compact `result_evidence`
view. Ask Codex what finished, what needs review, and which decision comes next.
Ask for the run's diagnostics when you need the detailed outcome and usage
report. This uses the existing `task` tool with `view: "diagnostics"`.

## What finished?

The result distinguishes work in progress, completed work needing review,
failed work, and unresolved evidence. A completed provider job does not mean
Codex accepted its changes. A provider's PASS message does not prove a check
passed. Codex reviews the exact candidate and makes the acceptance decision
in the conversation; the tool does not accept or merge code automatically.

The coordination packet keeps each producer's exact head and request identity.
Independent branches are not described as one composed candidate. Existing
handoffs and bounded provider results remain available beside the result
card. Missing checks or composition evidence stay unknown.

For corrections, follow the returned revision run ID. The original producer,
reviewed head, correction round, and existing child are retained. The fixed
limit is three successive correction rounds, with one distinct admitted child
per producer. An exhausted loop requires a deliberate new bounded assignment;
it never automatically starts one.

## What did this run use?

The report uses the existing usage ledger. The ordinary admission path derives
a bounded snapshot from its retained facts:

| Fact | Meaning |
| --- | --- |
| Submissions | One semantic run submission, counted once across its assignments |
| Provider invocations | Positively acknowledged dispatches; attempted but unacknowledged work remains unknown |
| Attention rounds | The admission runtime's recorded attention count |
| Elapsed time | Recorded time to the terminal handoff, including coordination delay; unknown while unavailable |
| Provider tokens and cost | Unknown on this path unless a separately bound ledger supplies them |
| Native tokens, helpers, and subscription balance | Unknown; the plugin does not read private host accounting |
| Tool calls and response/evidence bytes | Unknown where the runtime has not instrumented the complete quantity |

Run-wide counters contribute once to ledger totals. They are not measurements
of an individual provider's latency. Re-reading or restarting does not turn
cumulative observations into extra work. This report covers the current run;
it does not silently combine previous producers, revisions, or native helpers.
Compare the complete sequence when evaluating an outcome.

The ledger distinguishes host measurements, provider reports, evidence bytes,
and unknown values. Bytes are not tokens. Provider reports do not become host
measurements. Unlike provider/model token counts must remain distinguishable.
One run cannot establish savings against a workflow that was never measured.

## Sharing and reproducing evidence

The bounded result projection omits raw prompts, transcripts, and worktree
paths. Review identifiers and any selected evidence before posting a report;
a useful task name may still reveal private context. Nothing is published
automatically. Use the repository's support route to share the relevant
summary and your description of the problem.

The [run API](run-tool-api.md) describes the machine fields. In a source clone,
`benchmarks/README.md` describes case preparation and offline comparisons,
including native helpers, corrections, failed attempts, and missing metrics.
Paid comparisons need an explicit evaluation budget. Supplied fixture data
demonstrates the analyzer and is not a measured performance result.

The underlying helpers are `projectRunResultEvidenceV1`, `projectUsageReportV1`,
and `projectLocalOutcomeCardV1`. The existing PR/CI decision card retains its
separate exact-candidate requirements. The public catalog remains `status`,
`delegate`, `task`, `tasks`, and `cancel`.

Different feedback against a producer with an admitted child is rejected with
that child's id and a statement that the feedback was not applied. Inspect the
child before requesting its next correction. A pending durable reservation
without a child receipt requires inspection; it never authorizes a replay.
