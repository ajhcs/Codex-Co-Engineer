# Failed, helper, and cumulative comparison accounting

This retrospective task uses a bounded pre-fix snapshot of public repository
source. Repair the historical modules at their original paths so the frozen
checks in `checks/failed-helper-cumulative.test.mjs` pass.

Do not edit the check file, this prompt, or recorded identity. Do not copy
later corrected sources, Git history, or other trial outputs into the
workspace.

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

Acceptance is the frozen command
`node --test checks/failed-helper-cumulative.test.mjs`.
