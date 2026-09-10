# Run result evidence and comparison

Additive 3.4.3 helpers for a compact, truthful view of a simple run-admission
result and for offline comparison of sanitized trials. Parent still has to
wire the projection into admission, adapter, and response surfaces. These
modules are not MCP tools and are not live-provider jobs.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/usage-ledger.mjs`
- `plugins/codex-co-engineer/mcp/v3/final-decision-card.mjs`
- `plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs`
- `plugins/codex-co-engineer/test/run-result-evidence.test.mjs`
- `plugins/codex-co-engineer/test/r1-usage-ledger.test.mjs`
- `plugins/codex-co-engineer/test/r1-final-decision-card.test.mjs`
- `scripts/compare-coengineer-runs.mjs`
- `scripts/compare-coengineer-runs.test.mjs`
- `benchmarks/`
- this document

## Outcome and usage projection

Default output is a small summary. Detail is on-demand. The helpers reuse the
existing usage ledger and do not invent a second accounting system. The
PR/CI final decision card keeps its previous authority: a local completed
candidate is not PR-ready and is not Codex-accepted.

```js
import {
  summarizeRunResultEvidenceV1,
  detailRunResultEvidenceV1,
  projectRunResultEvidenceV1,
  describeRunResultEvidenceV1,
} from './plugins/codex-co-engineer/mcp/v3/run-result-evidence.mjs';

summarizeRunResultEvidenceV1(receipt)
detailRunResultEvidenceV1({ receipt, usage_ledger, artifacts, checks })
projectRunResultEvidenceV1(source, { view: 'summary' | 'detail' })
```

`source` is a simple run-admission receipt, or a closed wrapper:

| Key | Role |
| --- | --- |
| `receipt` | Trustworthy current admission receipt |
| `usage_ledger` | Existing `UsageLedgerV1` when parent recorded one |
| `codex_acceptance` | `{ accepted, authority: "codex" }` only |
| `candidate` | Optional typed identities; `composed` stays false unless supplied |
| `checks` / `artifacts` | Optional available checks and sanitized artifact refs |

Parent may call these from real admission receipt projection after runtime
wiring. Until that wiring exists, the helper is disconnected from MCP.

Supporting functions:

```js
summarizeUsageLedgerV1(ledger)
detailUsageLedgerV1(ledger)
projectUsageReportV1(ledger, { view })
unknownUsageReportV1(view)
projectLocalOutcomeCardV1(request)
projectFinalDecisionCardV1(request) // unchanged PR/CI card
```

## Limits

| Cap | Value |
| ---: | ---: |
| Usage summary | 1536 bytes (text 512) |
| Usage detail | 8192 bytes |
| Run-result summary | 2048 bytes |
| Run-result detail | 16384 bytes |
| Local outcome summary text | 512 bytes |
| Assignments | 1..8 |
| Artifact refs retained | 8 |

Shareable results omit owner-only prompts, transcripts, worktree paths, raw
artifact class, and private subscription or native-token scrapes. Missing
metrics stay `unknown`. Bytes are labeled as bytes. Provider-reported tokens
stay `provider_untrusted`. Savings are `not_inferred`. Completed, provider
PASS, and an unreviewed local candidate are not Codex acceptance.

## Comparison command

```bash
node scripts/compare-coengineer-runs.mjs --validate-cases benchmarks/cases
node scripts/compare-coengineer-runs.mjs \
  --cases benchmarks/cases \
  --trials benchmarks/fixtures/analysis-fixture.json
```

Arms: `native-codex`, `published-3.4.2`, `candidate-3.4.3`, optional
`direct-delegation`. Comparable trials share case, base SHA, host model, and
host settings; Co-Engineer arms also share provider configuration. Unrun and
unmatched arms are labeled. Failed attempts, corrections, and native helpers
are included. Cumulative snapshots of the same attempt ID are not
double-counted. Usage-per-accepted-result keeps failed-attempt usage in the
numerator. Zero accepted results are not zero cost. Paid live trials require
`--paid-budget` and are still not executed here.
