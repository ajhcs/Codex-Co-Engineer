# Contributor starter tasks

These are approachable, self-contained tasks. They are **not** pre-created
GitHub issues; open a new issue or pull request when you take one. Prefer a
focused fixture check over a full suite while iterating. Complex provider
integrations and cancellation-boundary redesigns need maintainer guidance and
are omitted here.

## 1. Clarify one local setup error path

**Problem:** A first-time user on a supported Linux host hits a missing
`systemd --user` or cgroup v2 prerequisite and cannot tell which check to run
next.

**Scope:** Improve one troubleshooting or configuration paragraph (and its
matching fixture or packaged-doc assertion if one already covers the phrase).
Do not change installer behavior or provider drivers.

**Acceptance:** The docs name the prerequisite and the next local command
(`status` or `setup:check` as appropriate). No personal paths or credentials.

**Check:**

```bash
node --no-warnings --test plugins/codex-co-engineer/test/branding.test.mjs
node scripts/validate-package-docs.mjs
```

## 2. Extend the first-outcome example

**Problem:** `examples/first-outcome` ships a useful but tiny summarize-checks
stub; contributors can deepen the utility or add one more frozen acceptance
case without live providers.

**Scope:** Edit only files under `examples/first-outcome/**`. Keep the starter
prompt in ordinary language. Do not weaken `check.mjs` to force a pass. Do not
add paid-provider or npm-package prerequisites.

**Acceptance:** Keep the shipped implementation incomplete so it remains an
assignment. Demonstrate the added case with a temporary completed implementation
and retain the intentionally failing baseline. Do not commit the answer to the
starter exercise. The example still copies into a fresh Git repository.

**Check:**

```bash
node examples/first-outcome/check.mjs
```

## 3. Document one supported-host setup failure

**Problem:** Maintainers need redacted reports of real setup failures on
supported hosts (Node 24+, Python 3.11+, Linux systemd/cgroup v2).

**Scope:** Add a short compatibility note under `docs/` (or extend
troubleshooting) with the failure category, host class, and the command that
surfaced it. Synthetic excerpts only.

**Acceptance:** Another reader can recognize the same failure class and know
which check to re-run. No private paths, logs from a personal home directory,
or credentials.

**Check:**

```bash
git diff --check
node scripts/validate-package-docs.mjs
```

## 4. Improve issue or PR template clarity

**Problem:** New reporters still leave out attempt/outcome, or PR descriptions
omit checks and limits.

**Scope:** Edit only `.github/ISSUE_TEMPLATE/**` or
`.github/pull_request_template.md`. Keep required fields minimal; keep the
private security route; do not claim Discussions is enabled.

**Acceptance:** Required bug fields and security advisory routing remain
present; PR template still has Problem / Result / Checks / Limits headings;
questions remain issue-based. These grep checks confirm key phrases—they are
not a YAML schema validator.

**Check:**

```bash
grep -n 'required: true' .github/ISSUE_TEMPLATE/bug.yml
grep -n 'security/advisories/new' .github/ISSUE_TEMPLATE/config.yml
grep -n '^## Problem\|^## Result\|^## Checks\|^## Limits' .github/pull_request_template.md
test ! -e .github/DISCUSSION_TEMPLATE
```

## 5. Add a fixture-only regression for a documented contract

**Problem:** A documented public contract (for example five-tool catalog text
or publication authority wording) can drift without a focused test.

**Scope:** Add or tighten one provider-free unit/fixture test under
`plugins/codex-co-engineer/test/`. No live provider calls, no schema version
bumps, no sixth tool.

**Acceptance:** The new or updated test fails when the contract text or
behavior regresses, and passes on the current tree.

**Check:**

```bash
# Run only the test file you added or changed, for example:
node --no-warnings --test plugins/codex-co-engineer/test/<your-contract-test>.mjs
```

## 6. Add one small frozen comparison case

**Problem:** Reproducible comparisons need useful shared tasks and decisive
acceptance checks before any paid cohort runs.

**Scope:** Add one case under `benchmarks/cases/` and update its fixture coverage
in `scripts/compare-coengineer-runs.test.mjs`. Follow `benchmarks/README.md` to
materialize the initial commit and retain its input digest. Keep the task small.

**Acceptance:** The initial input has the intended failure or review finding;
an independently checked solution satisfies the frozen acceptance. Repeated
materialization produces the same base commit. Unrun arms remain unrun; synthetic
measurements stay labeled. No paid providers are needed for this contribution.

**Check:**

```bash
node scripts/compare-coengineer-runs.mjs --validate-cases benchmarks/cases
node --no-warnings --test scripts/compare-coengineer-runs.test.mjs
```
