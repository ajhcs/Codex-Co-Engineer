# Comparison cases

Frozen engineering cases for offline comparison of native Codex (including
helpers), published 3.4.2, and the exact 3.4.3 candidate. Direct delegation is
an optional control arm.

This is not a first-run product example. Add a case by copying one JSON file
in `cases/` and keeping the same schema, comparable host settings, and
deterministic acceptance checks.

Analyze sanitized trial records only:

```bash
node scripts/compare-coengineer-runs.mjs \
  --cases benchmarks/cases \
  --trials benchmarks/fixtures/analysis-fixture.json
```

Paid repeated trials are opt-in with an explicit budget and are not implemented
by this command. Do not run live provider jobs from CI.
