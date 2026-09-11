# Host usage import

Offline importer for sanitized Codex session JSONL into comparison trial
records. This is host accounting only. It does not call providers, open
budgets, or run the release gate.

## Command

```bash
node scripts/collect-coengineer-trial-usage.mjs \
  --manifest path/to/manifest.json \
  --sessions-root path/to/allowlisted-sessions \
  [--write path/to/report.json]
```

Default output is stdout. Session files are read-only. `--write` is required
to persist a report. Exit status is `0` only for `complete`; `inconclusive`
returns nonzero. `--write` refuses to overwrite the manifest or any input
session path. Session realpaths are validated so symlink escapes outside the
sessions root fail closed.

## Manifest

Schema: `codex-co-engineer.host-usage-manifest.v1`

Required fields:

- `trial` — exact trial identity (`trial_id`, `case_id`, `arm`, `base_sha`,
  `input_digest`, `coengineer_source`, `host_model`, bounded `host_settings`,
  bounded `provider_configuration`, optional `accepted`)
- `window` — inclusive ISO-8601 `{ start, end }` bound for the trial
- `sessions` — allowlisted session files only (`id`, `role`, relative `path`,
  and `parent_id` for `native_helper` rows); duplicate paths and parent cycles
  are rejected
- `phases` — attempt mapping (`attempt_id`, `kind`, `outcome`, `sequence`,
  `{ start, end }`, `session_id`)

When `accepted` is omitted, the emitted trial omits the field and the report
is `inconclusive`. The importer never scans directories for unrelated sessions.
Linked native helpers are resolved only by exact allowlisted thread ids and
parent graph (no basename fallback). Unlisted or missing nested children are
rejected. Absolute session paths and freeform settings path/secret keys are
rejected.

## Event accounting

Primary evidence is `token_usage_record`:

- Deduplicate identical `response_id` rows within a session
- Identity is `session_id + response_id` so one session cannot suppress another
- Reject conflicting duplicates
- Support optional observed `cache_write_input_tokens`; cache stays separate
  from reasoning, and reasoning remains included in output
- Carry pre-window model/counters and reconcile in-window deltas to cumulative
  `thread_token_usage`
- Assign each source event to at most one phase: start-inclusive,
  end-exclusive at adjacent boundaries, closed only at a terminal endpoint
- Count compaction once across phases (compaction output is already inside
  response records)
- Bind allowlisted session ids to `session_meta` / thread ids and observable
  model settings; conflicts reject, unknown attribution is inconclusive

`event_msg` / `token_count` / `info.total_token_usage` is secondary and may
omit compaction. It is not authoritative.

`turn_context` supplies model/effort for breakdowns. `SubAgentActivity`
`started` links children recursively when allowlisted by exact id. Repeated
references do not double-count. Incomplete primary evidence makes the report
`inconclusive`; unknown metrics stay `{ value: null, source: "unknown",
trust: "unknown" }` and are never coerced to zero.

## Output

Schema: `codex-co-engineer.host-usage-report.v1`

- `trial` — complete `codex-co-engineer.benchmark-trial.v1` input for
  `scripts/compare-coengineer-runs.mjs`
- `breakdown` — per-attempt and total model / input-cache / cache-write /
  reasoning / compaction counters
- `evidence.digests` — manifest, session, link, and trial digests without raw
  prompts, reasoning text, output snippets, absolute source paths, or
  credentials

When parent and helper attempts are both present, the trial sets
`native_parent_excludes_helpers: true` so parent rows exclude separately
reported children.

## Budget and reports

Paid budget setup, live provider jobs, and release-gate qualification are
separate workflows. Do not use this importer to invent measured results or
subscription-dollar conversions.

## Tests

```bash
node --test scripts/collect-coengineer-trial-usage.test.mjs
```

Tests use synthetic fixtures only.
