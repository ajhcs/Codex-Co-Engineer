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
to persist a report file.

## Manifest

Schema: `codex-co-engineer.host-usage-manifest.v1`

Required fields:

- `trial` — exact trial identity (`trial_id`, `case_id`, `arm`, `base_sha`,
  `input_digest`, `coengineer_source`, `host_model`, `host_settings`,
  `provider_configuration`, optional `accepted`)
- `window` — inclusive ISO-8601 `{ start, end }` bound for the trial
- `sessions` — allowlisted session files only (`id`, `role`, relative `path`,
  and `parent_id` for `native_helper` rows)
- `phases` — attempt mapping (`attempt_id`, `kind`, `outcome`, `sequence`,
  `{ start, end }`, `session_id`)

The importer never scans directories for unrelated sessions. Linked native
helpers discovered in parent events are followed only when the child is
already allowlisted. Absolute session paths are rejected.

## Event accounting

Primary evidence is `token_usage_record`:

- Deduplicate identical `response_id` rows
- Reject conflicting duplicates
- Reconcile response sums to `thread_token_usage`
- Count compaction once (compaction output is already inside response records)
- Treat `reasoning_output_tokens` as included in `output_tokens`, never as an
  extra summand

`event_msg` / `token_count` / `info.total_token_usage` is secondary and may
omit compaction. It is not authoritative.

`turn_context` supplies model/effort for breakdowns. `SubAgentActivity`
`started` links children recursively when allowlisted. Repeated references do
not double-count. Absent child logs or incomplete primary evidence make the
report `inconclusive`; unknown metrics stay `{ value: null, source: "unknown",
trust: "unknown" }` and are never coerced to zero.

## Output

Schema: `codex-co-engineer.host-usage-report.v1`

- `trial` — complete `codex-co-engineer.benchmark-trial.v1` input for
  `scripts/compare-coengineer-runs.mjs`
- `breakdown` — per-attempt and total model / input-cache / reasoning /
  compaction counters
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
