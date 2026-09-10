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

**Acceptance:** After a complete `lib/summarize-checks.cjs` (or an agreed
extension), `node check.mjs` passes from that directory. The example still
copies cleanly into a fresh Git repository per the README.

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

## 6. Capture a small evaluation recipe outline

**Problem:** Reproducible comparisons need shared task inputs and acceptance
checks before any paid cohort runs.

**Scope:** Draft one short evaluation outline in `docs/` describing task
inputs, base commit discipline, acceptance checks, and what must stay fixed
across arms. Do not publish invented percentages or endorsement claims.

**Acceptance:** A maintainer can run the deterministic fixture parts without a
paid provider. Paid comparisons are explicitly optional and out of CI.

**Check:**

```bash
git diff --check
# Depends on scripts/compare-coengineer-runs.mjs (planned companion script).
# If that file is absent in this tree, skip the comparison CLI and rely on
# the outline's documented fixture steps plus git diff --check only.
test -f scripts/compare-coengineer-runs.mjs \
  && node scripts/compare-coengineer-runs.mjs --help \
  || echo "compare-coengineer-runs.mjs not present yet; outline-only check"
```
