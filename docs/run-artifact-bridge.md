# Run artifact bridge (P33)

P33's artifact bridge is the identity-and-audience authority between
owner-only raw evidence and bounded sanitized model-facing projections.
It does not own the P08 store, P09 sanitizer, P13 evidence bundle, run
runtime, scheduler, lifecycle, server, or candidate composer. Those seams
are injected. It does not claim Gate A or release.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-artifact-bridge.mjs`
- `plugins/codex-co-engineer/test/r1-run-artifact-bridge.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-artifact-bridge-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-artifact-bridge-fixtures.mjs`
- this document

## Factory

```js
createRunArtifactBridge({ rawStore, sanitizer, evidenceBundle, clock })
```

The options object has exactly those four keys. Extra keys, proxies,
accessors, and missing methods fail closed. The return is a frozen object
with exactly:

- `captureAssignmentArtifacts`
- `projectAssignmentArtifacts`
- `cleanupRunArtifacts`

`clock.now()` must return a UTC second-precision timestamp
(`YYYY-MM-DDTHH:MM:SSZ`).

## Injected seams

| Seam | Required methods | Role |
| --- | --- | --- |
| `rawStore` | `publish`, `get`, `list`, `remove` | Owner-only raw `ArtifactRefV1` bytes |
| `sanitizer` | `sanitize` | Bound sanitized projection plus redaction counts |
| `evidenceBundle` | `append`, `list` | Content-free capture/projection/cleanup events |
| `clock` | `now` | Deterministic timestamps |

The bridge never imports those implementations. Tests use scoped in-memory
stubs. A later runtime lane may inject the accepted P08/P09/P13 authorities.

Raw store records are `{ artifact_ref, bytes }` and may round-trip
capture provenance `source_truncated`. Missing provenance is unknown.
`list({ run_id })` must return only that run; a foreign `run_id` fails
closed and prevents cleanup.

`sanitize({ artifact_ref, source, source_truncated })` must return a
sanitized-class `ArtifactRefV1` for the same run, assignment, kind, and
path, plus detached `bytes` that hash to that ref. A raw-class result is
denied. Credential patterns in those bytes fail closed.

## Capture

`captureAssignmentArtifacts` is the owner-only write path. Required keys:

`run_id`, `assignment_id`, `artifact_kind`, `relative_path`, `media_type`,
`source`.

Optional keys: `content_encoding` (must be `identity`) and
`source_truncated`.

`source` is a string or an intrinsic `Buffer`/`Uint8Array`. Empty or
over-cap sources fail. The relative path must be a P07 portable path and
must stay under `runs/<run_id>/<assignment_id>/`. Path authority cannot
broaden to another run, a parent segment, a worktree, or a candidate ref.

The raw ref is published through `rawStore.publish` and re-read before the
receipt is returned. Readback is bound to the captured bytes: the stored
payload is hashed and must match the captured digest and identity. A
hash mismatch, substituted payload, partial read, missing bytes, or stale
artifact fails closed. The sanitizer is asked for the matching sanitized
ref. The receipt is detached and frozen. It carries raw and sanitized
refs, redaction metadata, truncation/completeness, and `created`. It
never includes source bytes, store roots, or live handles. Missing
sanitizer redaction or version evidence is `null`, never `0` or `1`.

An identical digest at the same identity is a restart replay
(`created: false`) and does not duplicate storage. A different payload at
that identity is `artifact_bridge_restart_conflict` and leaves the original
bytes in place.

## Projection

`projectAssignmentArtifacts` is the model-facing read path. Required keys:

`run_id`, `assignment_id`.

Optional keys: `offset` (default `0`) and `max_bytes` (default and maximum
`8192`).

The bridge lists that assignment's raw artifacts, re-sanitizes each one,
and returns only sanitized refs plus a base64 selected window. Raw class,
raw bytes, credentials, prompt text, and store roots are absent. A
credential pattern that survives the sanitizer fails closed rather than
being projected.

Projection preserves authoritative `redaction_count`, `sanitizer_version`,
`source_truncated`, and `complete` when the sanitizer supplies them.
Missing values stay `null`; the bridge never fabricates `0`, `1`, `false`,
or `true`. Truncation is absorbing: projection may keep or mark a source
truncated/incomplete, but it never upgrades truncated evidence to
complete. Capture provenance `source_truncated` is passed through on
restart rather than reset to `false`. `reader_clipped` / `more` remain
paging facts and are distinct from source completeness.

Restart constructs a new bridge over the same injected raw store. Projection
re-reads raw bytes and re-sanitizes; it does not invent artifacts.

## Cleanup

`cleanupRunArtifacts` is manual and proof-bound. Required keys:

`run_id`, `proof`.

`proof` requires `run_id` and may include `assignment_ids` (1..8 unique
assignment ids). `proof.run_id` must equal the request `run_id`. Unknown
proof keys, including `worktree`, `branch`, `lock`, and `candidate`, fail
closed. There is no automatic garbage collection.

Cleanup lists the proven run, refuses any foreign `run_id` or path, and
only then calls `rawStore.remove` with the exact listed identities. A
subset proof cannot remove a sibling assignment. A second call is
idempotent (`removed: 0`, `cleaned: true` when the targeted set is gone).
Worktrees, branches, handoffs, task receipts, and candidate refs are
outside this facade and are never deleted here.

## Errors

Failures are `RunContractV1Error` values with a closed code vocabulary.
Messages are content-free. They never echo source bytes, credentials,
absolute paths, or store errors. Injected-store exceptions become
`artifact_bridge_store_failed`.

## Non-goals

Runtime composition, scheduler dispatch, lifecycle settlement, MCP server
cutover, candidate refs, CHANGELOG/future-work edits, version changes, and
Gate A remain unclaimed.
