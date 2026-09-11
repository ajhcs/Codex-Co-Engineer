# Failed, helper, and cumulative comparison accounting

This frozen case reproduces the 3131f9ac7f6807eccb2ab68f027f1d98d3db3661
offline comparator defects later corrected in the 3.4.3 candidate: usage per
accepted result dropped incomplete acceptance coverage, mixed providers were
blended, native helpers could double-count, wall time was confused with the
sum of attempt durations, and cumulative snapshots could overwrite a terminal
failure.

Repair `account-trials.mjs` so the frozen checks in `account-trials.test.mjs`
pass. Do not edit the test file, this prompt, or the recorded identity. Do not
copy later corrected sources into the workspace.

Required behavior:

- Count every attempt, including failed attempts, corrections, and native
  helpers. Failed attempts remain in the usage-per-accepted numerator.
- If any trial in the arm is missing `accepted`, usage-per-accepted and the
  acceptance rate stay unknown until coverage is complete. Zero accepted is
  not zero cost.
- Unknown metrics stay unknown. Missing primary evidence is inconclusive, not
  measured zero.
- `elapsed_ms` is the sum of attempt durations. `wall_elapsed_ms` is trial
  wall time and is not that sum.
- When native helpers are recorded separately, the parent must set
  `native_parent_excludes_helpers: true`. Helper usage is added once.
- Duplicate `attempt_id` values are compatible cumulative snapshots only when
  kind, provider/model, and terminal outcome stay consistent, sequence
  increases, and usage is monotone. A later snapshot cannot turn a terminal
  failure into acceptance or move reported usage onto another model.
- Provider tokens and cost stay grouped by provider and model. Mixed
  provider/model totals are unknown/non-comparable, not one blended number.
- An arm cannot mix `coengineer_source` identities.

Acceptance is the frozen command `node --test account-trials.test.mjs`.
