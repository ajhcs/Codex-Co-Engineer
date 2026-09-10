# Starter prompt

Copy into a Codex session after Co-Engineer is installed and one provider is
authenticated:

> Use Grok Co-Engineer to implement `lib/summarize-checks.cjs` so the local CLI
> `node summarize-checks.mjs` summarizes named check results from JSON: counts of
> `passed`, `failed`, and `skipped`, plus the ordered names of failures. Keep the
> existing CLI and `formatSummary` contract. Make the frozen acceptance
> `node check.mjs` pass. Do not edit `check.mjs` to force a pass. Commit the
> result in the assigned workspace.

Replace `Grok` with `Cursor` or `Muse` if that is your chosen provider. Keep the
same acceptance check.
