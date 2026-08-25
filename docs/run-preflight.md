# Run preflight — launch-side validation gate (P26)

The P26 run preflight is one additive v3 module,
`plugins/codex-co-engineer/mcp/v3/run-preflight.mjs`. It is the validation
gate between an authored run submission and any later launch surface: it
proves a run is launchable exactly as submitted, and it launches nothing.

## Validate only

A preflight pass creates **no workspace, no branch or ref, no task dispatch,
no credential projection, no remote mutation, and no reservation** — and a
preflight failure leaves even less. The receipt carries an all-false
side-effect nonclaim map so consumers can assert the boundary in tests. The
module never writes to the filesystem; its only process spawns are read-only
git observations (`rev-parse`, `cat-file -t`, `for-each-ref`) run argv-only
under the accepted closed git environment with `--no-replace-objects
--no-optional-locks`, disabled hooks/fsmonitor/untracked-cache, so even
advisory lock files cannot appear as an observation side effect.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-preflight.mjs`
- `plugins/codex-co-engineer/test/r1-run-preflight.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-preflight-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-preflight-fixtures.mjs`
- this document

## Exact canonical repository/base identity

The repository and base SHA are observed on the host, not taken from the
submission's word alone. One observation proves all of:

- the path is a real directory identical to its own canonical `realpath`
  spelling — symlink aliases, bare repositories, non-work-tree roots, and
  alternate directory spellings fail closed;
- git independently reports the same work tree toplevel as the submitted
  path and yields a trusted absolute git directory;
- the `.git` layout is trusted: a `.git` directory must resolve to the
  observed git dir, a linked-worktree `.git` file must point (absolutely or
  relatively) at the same resolved target, and symlinked `.git` entries are
  rejected;
- the base exists in that repository as **exactly one immutable commit
  object**: full 40-character lowercase hex is enforced by the accepted P02
  grammar before any process runs, so symbolic spellings (`HEAD`, `@`,
  branch names), abbreviations, uppercase hex, suffix expressions, and
  SHA-256-length strings never reach git; annotated tag objects, trees, and
  blobs are denied as a base even though they are valid objects;
- no `refs/replace/*` entry shadows object identity.

Detached HEAD is deliberately irrelevant: the base identity comes from the
object database, never from where HEAD happens to point.

## Bounded independent fanout

The launch boundary owns the fanout invariant as frozen literals:
`PREFLIGHT_MIN_CHILDREN = 1`, `PREFLIGHT_MAX_CHILDREN = 8`. The child count
is enforced against those literals **before** the composed upstream contract
runs, so a routine quota change anywhere else can never widen the public
maximum: even a future grammar that tolerated more children would still fail
preflight with the boundary's own `preflight_child_count_exceeded` denial.
Independence is re-asserted over the detached frozen snapshot — no
dependency edge of any shape (`preflight_dependency_edge_denied`) and no
duplicate child id (`preflight_duplicate_child_id`) — and writer-scope
disjointness is re-checked pairwise with the accepted conservative
static-prefix intersection, so overlapping writer scopes are detected at
this boundary even though upstream already denies them.

## Composition

Preflight composes accepted surfaces and invents none of their semantics:

| Surface | Owner | Use here |
| --- | --- | --- |
| Run envelope, assignments, policy, scope grammar | P02 `run-manifest` / `run-policy` | complete contract via `parseRunManifestV1()` |
| GitIdentityV1 digest binding | P03 `protected-identity` / `identity` | receipt carries `buildGitIdentityV1()` bytes |
| Selection resolution | P05 resolver | not invoked; resolution stays behind its own authority |
| Provider composition | P23 registry | not invoked; nothing is composed or dispatched |
| Durable submission | P24 run store | consumes `receipt.git_identity`; nothing is written |

Upstream denial codes pass through unchanged, so existing callers keep
their accepted error vocabulary; codes owned by this boundary live in the
closed `RUN_PREFLIGHT_ERROR_CODES` list.

## Non-goals

No workspace provisioning, branch creation, dispatch, scheduling, provider
composition, selection resolution, store writes, cleanup ownership,
supervisor/server cutover, merge or PR authority, direct mode, network
access, or credential handling. Preflight failure output is bounded and
content-free: messages are fixed templates that never echo hostile values.

## API

- `validateRunPreflightV1(request, options?)` — async; returns a detached,
  deeply frozen ready receipt or throws a typed content-free
  `RunContractV1Error`. `request` is `{ manifest }`; `options` may inject
  `spawn` (test seam) and `host` facts.
- `describeRunPreflightV1()` — deterministic deep-frozen inventory of the
  schema, bounds, checks, error codes, and nonclaims.
- `RUN_PREFLIGHT_SCHEMA_ID`, `RUN_PREFLIGHT_VERSION`,
  `PREFLIGHT_MIN_CHILDREN`, `PREFLIGHT_MAX_CHILDREN`,
  `PREFLIGHT_RAM_FLOOR_BYTES_PER_CHILD`, `RUN_PREFLIGHT_CHECKS`,
  `RUN_PREFLIGHT_SIDE_EFFECT_NONCLAIMS`, `RUN_PREFLIGHT_ERROR_CODES`,
  `RUN_PREFLIGHT_READONLY_GIT_COMMANDS`.

## Testing

```
node --no-warnings --test test/r1-run-preflight.test.mjs \
  test/r1-run-preflight-adversarial.test.mjs \
  test/r1-run-preflight-side-effect.test.mjs
```
