# Comparison cases

Frozen engineering cases for offline comparison of native Codex (including
helpers), published 3.4.2, and the exact 3.4.3 candidate. Direct delegation is
an optional control arm.

This is not a first-run product example. Cases are local file sets with frozen
acceptance checks. `base_sha` is the Git commit produced by the deterministic
materializer from those bytes, not a fictional hash and not a paid-run claim.
`analysis-fixture.json` is a synthetic, unverified record used to exercise the
offline command. It is not independently verified and is not a live provider
result.

## Prepare a case

Destination must be empty. The command writes only the frozen relative files
and creates one reproducible initial commit with fixed Git identity and time.

```bash
DEST=$(mktemp -d "${TMPDIR:-/tmp}/ce-case-XXXX")
node scripts/compare-coengineer-runs.mjs \
  --materialize-case benchmarks/cases/single-file-bugfix.json \
  --destination "$DEST"
```

Identity used for that commit:

- name: `Co-Engineer Benchmark`
- email: `benchmark@invalid`
- date: `2026-01-01T00:00:00+0000`
- message: `codex-co-engineer.benchmark-case.v1:<case-id>`

Repeated materialization of the same case in another empty directory must
produce the same `base_sha`. Trials bind that SHA plus the case `input_digest`.

## Frozen acceptance

Do not edit the case test files to make a trial pass. After materializing,
run the exact frozen check from the case JSON. Example for
`single-file-bugfix`:

```bash
node --test "$DEST/sum.test.mjs"
```

`failing-check-then-fix`:

```bash
node --test "$DEST/even.test.mjs"
```

`review-driven-correction`:

```bash
node --test "$DEST/parse-count.test.mjs"
```

`independent-review` is a review-finding case. Acceptance is the frozen
`must_include` string in the case JSON, not a command, and `clamp.mjs` is
forbidden to change.

Changed checks change `input_digest` and are rejected unless the frozen digest
is updated with the case.

## Host and provider config

Comparable trials use the same host model and settings:

```json
{ "host_model": "codex-default", "host_settings": { "reasoning": "default", "sandbox": "workspace-write" } }
```

Co-Engineer arms also share the case `provider_configuration` and an exact
`coengineer_source` identity (git commit or labeled synthetic source). An arm
label cannot mix candidate builds. Native Codex uses
`{ "kind": "native", "value": "native-codex" }`. Duplicate case IDs are
rejected.

For real trials, replace the fixture's `codex-default` label with the actual
host model id and record the effective settings. Record the external model ids
and routes in `provider_configuration`, keeping them fixed across Co-Engineer
arms. Resolve these before collecting a cohort. A stock-default setting is not
proof that two sessions used the same effective model. Operator-supplied records
remain unverified until their retained evidence is independently checked.

## Analyze sanitized records

Unknown flags are rejected. `--cases` and `--trials` are required for
analysis. `--validate-cases DIR` accepts the directory as its own argument.

```bash
node scripts/compare-coengineer-runs.mjs --validate-cases benchmarks/cases
node scripts/compare-coengineer-runs.mjs \
  --cases benchmarks/cases \
  --trials benchmarks/fixtures/analysis-fixture.json \
  --protocol benchmarks/protocol.json
```

The fixture output is labeled `synthetic_unverified`. It does not claim
`invented_results: false` as independent verification.

## Accounting

- Count every attempt, including failed attempts, every correction, and native
  helpers.
- `elapsed_ms` is the sum of attempt durations. `wall_elapsed_ms` is trial wall
  time. Parallel native helpers are not wall time.
- Native parent usage must set `native_parent_excludes_helpers: true` when
  helpers are recorded separately.
- Same-attempt cumulative snapshots must increase sequence and keep terminal
  outcomes and provider/model attribution. A later snapshot cannot overwrite a terminal failure with an
  incompatible outcome.
- `usage_per_accepted_result` keeps failures and corrections in the numerator.
  If any trial in the arm is missing `accepted`, the ratio is unknown until
  acceptance coverage is complete. Zero accepted is not zero cost.
- Provider tokens and cost stay grouped by provider and model. Mixed
  provider/model totals are unknown/non-comparable, not one blended number.
- Native tokens are not converted into subscription dollars.

Repeated trials are extra trial rows with the same case, arm, source identity,
host settings, and materialized base. Paid live jobs are not implemented:

```bash
node scripts/compare-coengineer-runs.mjs --live --paid-budget 1
```

That command still refuses to run jobs. Budgeted paid trials stay manual.
