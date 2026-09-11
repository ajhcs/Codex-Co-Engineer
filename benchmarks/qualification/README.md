# 3.4.3 retrospective qualification cases

Frozen representative evaluation inputs for the public 3.4.3 candidate
`c50550e0a12e6ce8f7564d0e384f52c205640ce5`. These three tasks are retrospective:
they reconstruct real pre-fix defects from public repository history. They are
**unrun**. This directory is not measured provider evidence.

The existing offline comparator and the four fixtures under
`benchmarks/cases/` are reused as-is. This helper does not change their API.

## Cases

| Case | Pre-fix source SHA | Implement | Review |
| --- | --- | --- | --- |
| `acp-deadline-concurrent-cancel` | `dede188029aff117c60e9a8c4299cc0ab0838be9` | Cursor | Grok |
| `run-result-outcome-acceptance` | `3131f9ac7f6807eccb2ab68f027f1d98d3db3661` | Grok | Cursor |
| `comparison-failed-helper-cumulative` | `3131f9ac7f6807eccb2ab68f027f1d98d3db3661` | Grok | Cursor |

Each packed case binds that source SHA, the SHA-256 input digest of the frozen
files and acceptance checks, and the Git commit produced by the deterministic
materializer. Those hashes are measured, not invented.

Worker context is the small isolated task only. It does not include later
corrected sources, candidate history, or solutions. Acceptance checks the
semantic defects, not exact prose.

## Protocol

Four approaches: `native-codex`, `published-3.4.2`, `candidate-3.4.3`, and
optional `direct-delegation`. Three cases × two repetitions = 24 trials.
Seeded ordering uses seed `43`. The entire-trial deadline is one hour, with at
most three corrections.

Host Astra settings and exact external model/routes must be recorded at
execution before freezing. Do not invent backend IDs. The packed
`codex-default` host label is a placeholder until that recording.

Freeze thresholds (see `protocol.json`):

- candidate 6/6 accepted
- median case-level native output per accepted result ≤ 50% native and ≤ 75% of 3.4.2
- Astra own output decreases versus 3.4.2
- median turnaround ≤ 2× native
- native overhead ≤ 1.25× direct
- failed attempts remain in the numerator
- missing primary evidence is inconclusive
- $25 paid ceiling

## Prepare a worker case

Destination must be empty. Prefer `TMPDIR`.

```bash
DEST=$(mktemp -d "${TMPDIR:-/tmp}/ce-qual-XXXX")
node scripts/prepare-coengineer-qualification.mjs \
  --materialize-case benchmarks/qualification/cases/acp-deadline-concurrent-cancel.json \
  --destination "$DEST"
node --test "$DEST/turn-runner.test.mjs"
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

## Safeguards

Live jobs are not implemented. Paid repeated trials remain opt-in, capped at
$25, and this helper still refuses to run them. Do not run the release gate,
publish, or mutate baseline/candidate trees outside the assigned worktree. The
public catalog remains `status`, `delegate`, `task`, `tasks`, and `cancel`.
