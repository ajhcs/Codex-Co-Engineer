# Cursor Cloud result source (P12)

Status: implemented as result-source materialization over accepted P09/P10
artifact contracts. Not live Cloud dispatch, scheduler, or evidence-bundle
composition.

The P12 `CursorCloudResultSourceV1`
(`plugins/codex-co-engineer/mcp/v3/cursor-cloud-result-source.mjs`)
materializes Cursor Cloud provider-reported result/output/status and
independently observed Git/branch/commit/PR evidence as distinct typed
sources. Trusted Git facts are never synthesized from provider text.

Existing `mcp/v3/cursor-cloud-driver.mjs` is unchanged. The only runtime
seam is a narrow result projection in `mcp/v3/cursor-cloud-worker.mjs`.

## Distinct sources

- **Provider report** (`artifact_kind: provider_report`): provider-reported
  status plus complete available output/error bytes.
- **Git evidence** (`artifact_kind: git_diff`): independently observed
  repository, branch, head/base SHAs, linear history, and PR URL.

A SHA, branch, or PR URL that appears only in provider output stays in the
provider-report artifact. It is never copied onto the Git-evidence receipt.

## Publication

`materializeCursorCloudResultSourceV1(store, options)` publishes complete
transport-available bytes through `sanitizeAndPublishArtifactV1` and
verifies with `verifyStoredArtifactV1`. Model-facing tails are read only
through `readSanitizedArtifactV1`. Empty sources are not published.

Receipts are detached deep-frozen content-free metadata: refs, digests,
provenance, bounded sanitized tails, and typed Git identity fields. They
never expose raw bytes, secrets, prompt text, store roots, or live handles.

## Truncation

- `source_truncated` / `complete` are caller-declared upstream/provider
  facts, never inferred from tail length or class caps.
- `inline_clipped` is the local 4,096-byte UTF-8 tail window.
- Crossing a class cap fails closed. The writer does not clip toward the
  cap or relabel storage limits as upstream truncation.
- 3.2.1 `result_*` bounding remains local clipping and is not treated as
  `source_truncated`.

Provider-report and Git-evidence truncation flags are independent.

## Identity

Exact `run_id`, `assignment_id`, request, provider run, repository,
branch, and head/base identities are bound into ArtifactRef paths and the
receipt. Observed correlation that disagrees fails closed with a typed
content-free mismatch code. There is no replay or fallback.

3.2.1 Cloud tasks without exact R1 run/assignment/model identity keep the
existing public terminal path. P12 publication attaches only when that
identity is present.

## Coverage and non-claims

Coverage lives in `test/r1-cursor-cloud-result-source.test.mjs`,
`test/r1-cursor-cloud-result-source-adversarial.test.mjs`, and the Cloud
worker suite.

This slice does not dispatch Cloud runs, qualify a live transport, cut
over scheduler/store/supervisor, mutate Git, create PRs, or implement P13
evidence bundles or P23/P32 work. Provider completion remains evidence,
never acceptance.
