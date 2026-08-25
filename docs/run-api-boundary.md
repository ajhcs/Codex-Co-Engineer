# Run API boundary (P32)

The P32 run API boundary is one additive v3 adapter,
`plugins/codex-co-engineer/mcp/v3/run-api-boundary.mjs`. It validates and
projects already-produced accepted P30 protected-ref audit receipts and P31
run-orchestration receipts into a detached, deeply frozen, content-free
`RunApiBoundaryV1` result.

## Values only

`projectRunApiBoundaryV1(input)` consumes JSON values. It does not call P30
audit functions, P31 prepare/dispatch/cancel/restart functions, Git,
filesystem, process, network, provider, credential, handoff, workspace,
reservation, supervisor, server, or release mechanisms. A later API or
release layer may read the projection; this adapter does not expose a
public MCP tool, change the supervisor, execute commands, decide a
release, claim Gate A, or mutate a remote.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-api-boundary.mjs`
- `plugins/codex-co-engineer/test/r1-run-api-boundary.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-api-boundary-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-api-boundary-fixtures.mjs`
- this document

## Closed paired projection

The request names the adapter schema/version, a credential-free run/base
identity, one P30 receipt, and either one P31 receipt or one P31/P26
denial object. An optional P31 lifecycle object may accompany a receipt.
Matching `run_id`, `base_sha`, declared `assignment_id`, and declared
provider are bound without broadening either upstream authority. Missing,
mismatched, duplicated, aliased, unknown-key, cyclic, accessor, Proxy,
exotic-prototype, and hostile collection inputs fail closed.

The result projects only closed status, check, fact, discrepancy, and
lifecycle summaries:

| Overall status | Meaning |
| --- | --- |
| `ready` | P30 verified and P31 receipt is clean; lifecycle is absent, cleaned, or a live restart |
| `failed` | P30 receipt is failed, carries failing ref-drift findings, or records a `moved_ref`, `missing_ref`, `symbolic_ref`, or `aliased_ref` comparison |
| `denied` | P31/P26 failed-preflight or capacity-denied input |
| `unresolved` | P31 lifecycle is not clean |

A failed or ref-drift audit remains `failed`, including a verified P30
receipt whose comparisons still record `moved_ref`, `missing_ref`,
`symbolic_ref`, or `aliased_ref`. A prepared P31 receipt, or a lifecycle
attached to one, that claims `task_dispatched` or
`provider_process_started` fails closed. A non-clean lifecycle remains
`unresolved`. The adapter does not upgrade, normalize away, or reinterpret
upstream negative evidence. Nested P30 and P31 statuses stay as supplied.

## Content-free evidence

Results and typed errors never echo credential values, environment values,
argv, raw errors, absolute paths, handoff paths, Git/SSH/hosting data,
arbitrary provider text, object inspection output, or caller-controlled
diagnostic prose. Nested P26 repository paths, git directories, lane
handoff identities, and projected key names are accepted as upstream
schema and then dropped.

The result also carries an all-false adapter side-effect nonclaim map:
`audit_executed`, `orchestration_executed`, `git_invoked`,
`filesystem_invoked`, `process_invoked`, `network_invoked`,
`provider_invoked`, `credentials_accessed`, `env_accessed`, `argv_accessed`,
`handoff_accessed`, `workspace_created`, `reservation_held`,
`remote_mutated`, `supervisor_cutover`, `public_api_exposed`,
`release_decided`, `gate_a_claimed`.

## Composition

P32 consumes accepted surfaces and invents none of their semantics:

| Surface | Owner | Use here |
| --- | --- | --- |
| Live protected-ref audit receipt | P30 `protected-ref-audit.mjs` | schema/version/status/finding/fact/discrepancy vocabulary; functions are not called |
| Run orchestration receipt, denial, lifecycle | P31 `run-orchestration.mjs` | schema/version/status/intent/lane/side-effect/cleanup vocabulary; functions are not called |
| Preflight nested receipt and denial codes | P26 `run-preflight.mjs` | nested ready receipt and fail-closed codes; `validateRunPreflightV1` is not called |
| Protected/default classification | P28 | comparison `ref_class` vocabulary only |
| Credential isolation | P29 | not invoked; credential values never appear |
| API, supervisor/server, release, Gate A | later slices | not invoked |

P30 remains the live-ref audit seam. P31 remains the dispatch
orchestration seam. This module does not wrap either, does not grant
merge, rebase, push, PR, tag, or protected-ref write authority, and
records remote mutation as denied.

## Non-goals

No audit execution. No prepare, dispatch, cancel, restart, or cleanup
execution. No Git, filesystem, process, or network invocation. No
credential, environment, argv, or handoff access. No workspace,
reservation, supervisor/server cutover, public MCP tool, release, or
Gate A authority.

## API

- `projectRunApiBoundaryV1(input)` — pure; returns a detached, deeply
  frozen result or throws a typed content-free `RunContractV1Error`.
- `describeRunApiBoundaryV1()` — deterministic deep-frozen inventory of
  the schema, bounds, checks, error codes, nonclaims, and composed
  surfaces.
- `RUN_API_BOUNDARY_SCHEMA_ID`, `RUN_API_BOUNDARY_VERSION`,
  `RUN_API_BOUNDARY_STATUSES`, `RUN_API_BOUNDARY_CHECKS`,
  `RUN_API_BOUNDARY_ERROR_CODES`,
  `RUN_API_BOUNDARY_SIDE_EFFECT_NONCLAIMS`.

## Testing

```
node --no-warnings --test test/r1-run-api-boundary.test.mjs \
  test/r1-run-api-boundary-adversarial.test.mjs
```
