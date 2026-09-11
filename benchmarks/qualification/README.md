# 3.4.3 retrospective qualification cases

Frozen representative evaluation inputs for public 3.4.3 qualification.
These three tasks are retrospective: they reconstruct real pre-fix defects
from public repository history and byte-bind those sources. They are
**unrun**. This directory is not measured provider evidence.

The existing offline comparator and the four fixtures under
`benchmarks/cases/` are reused as-is. This helper does not change their API.
Qualification cases use a separate schema because historical source
materialization exceeds the small-fixture file and path limits.

Candidate SHA/tree, Astra model, host settings, and provider/model routes are
**not** tracked here. Bind them in an external execution manifest before
collection. `codex-default` is not comparable truth.

## Cases

| Case | Pre-fix source SHA | Implement | Review |
| --- | --- | --- | --- |
| `acp-deadline-concurrent-cancel` | `dede188029aff117c60e9a8c4299cc0ab0838be9` | Cursor | Grok |
| `run-result-outcome-acceptance` | `3131f9ac7f6807eccb2ab68f027f1d98d3db3661` | Grok | Cursor |
| `comparison-failed-helper-cumulative` | `3131f9ac7f6807eccb2ab68f027f1d98d3db3661` | Grok | Cursor |

Each packed case binds that source SHA, SHA-256 digests of the frozen
allowlist and independent acceptance checks, and the Git commit produced by
the deterministic materializer. Those hashes are measured, not invented.

Worker context is the bounded historical snapshot plus the frozen prompt and
checks. It does not include later corrected sources, candidate history, or
solutions. Acceptance checks the semantic defects, not exact prose.

## Protocol

Four **required** approaches: `native-codex`, `published-3.4.2`,
`candidate-3.4.3`, and `direct-delegation`. Direct delegation is not optional
for this qualification. Three cases × two repetitions = 24 trials. Seeded
ordering uses seed `43`. The entire-trial deadline is one hour, with at most
three corrections.

Record the actual candidate SHA/tree, published SHA, Astra model, host
settings, and exact provider/model routes in the external execution manifest
before collection. Native has no external jobs but uses the same planned host
config. Never invent backend IDs.

Offline freeze thresholds (see `protocol.json`):

- candidate 6/6 accepted
- three task-level median native-output-per-accepted ratios: ≤ 50% of native
  and ≤ 75% of published 3.4.2 (median of the three tasks, not a pooled ratio)
- Astra own output decreases versus published 3.4.2 using model breakdown
- median turnaround ≤ 2× native
- native overhead ≤ 1.25× direct
- failed attempts, corrections, and helpers remain in the numerator
- missing primary evidence, missing acceptance, accounting gaps, and identity
  mismatches are inconclusive
- $25 paid ceiling

## Prepare a worker case

Destination must be empty. Prefer `TMPDIR`.

```bash
DEST=$(mktemp -d "${TMPDIR:-/tmp}/ce-qual-XXXX")
node scripts/prepare-coengineer-qualification.mjs \
  --materialize-case benchmarks/qualification/cases/acp-deadline-concurrent-cancel.json \
  --destination "$DEST"
node --test "$DEST/checks/deadline-concurrent.test.mjs"
```

The known-bad source is expected to fail that frozen check.

## Operator extract of pre-fix modules

This is not worker context. It copies an immutable allowlist from the recorded
pre-fix SHA into an empty destination.

```bash
DEST=$(mktemp -d "${TMPDIR:-/tmp}/ce-qual-src-XXXX")
node scripts/prepare-coengineer-qualification.mjs \
  --extract-source --case comparison-failed-helper-cumulative \
  --destination "$DEST"
```

## Evaluate a sanitized cohort

Supply sanitized trial records and a recorded execution manifest. Live jobs
are not implemented.

```bash
node scripts/prepare-coengineer-qualification.mjs \
  --evaluate-cohort \
  --trials path/to/sanitized-trials.json \
  --execution-manifest path/to/recorded-execution-manifest.json
```

## Safeguards

Live jobs are not implemented. Paid repeated trials remain opt-in, capped at
$25, and this helper still refuses to run them. Do not run the release gate,
publish, or mutate baseline/candidate trees outside the assigned worktree. The
public catalog remains `status`, `delegate`, `task`, `tasks`, and `cancel`.
