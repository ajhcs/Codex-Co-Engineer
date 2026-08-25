# Live protected-ref audit (P30)

The P30 live protected-ref audit is one additive v3 module,
`plugins/codex-co-engineer/mcp/v3/protected-ref-audit.mjs`. It compares
declared protected and default refs against immutable expected identities
on the host. It does not mutate Git, materialize credentials, talk to a
remote, expose an API, dispatch a run, or claim Gate A / release
authority.

## Read-only comparison

`auditProtectedRefsV1(request, options?)` observes the local repository
and returns a detached, deeply frozen receipt. A passing audit and a
failing audit both leave the repository byte-identical: the same files,
the same refs, the same index, and the same config. The only process
spawns are argv-only git observations (`rev-parse`, `for-each-ref`) under
the accepted P29 inspect environment with `--no-replace-objects
--no-optional-locks`, disabled hooks/fsmonitor/untracked-cache, so even
advisory lock files cannot appear as an observation side effect.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/protected-ref-audit.mjs`
- `plugins/codex-co-engineer/test/r1-protected-ref-audit.test.mjs`
- `plugins/codex-co-engineer/test/r1-protected-ref-audit-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-protected-ref-audit-fixtures.mjs`
- this document

## Declared protected and default refs

The request names the credential-free P28 identity and an explicit list of
`{ref, sha}` expected identities. Every declared ref must be a P28
protected or default ref (`classifyRefV1` / `isProtectedRefV1`). Worker
lane refs, unclassified grammar, and hostile names fail closed before any
git process starts. Expected SHAs are exact 40-character lowercase hex
object identities.

The live snapshot records, for each declared ref, a content-free
comparison:

| Outcome | Meaning |
| --- | --- |
| `match` | observed object name equals the expected SHA |
| `missing_ref` | declared ref is absent |
| `moved_ref` | declared ref exists but points at a different object |
| `symbolic_ref` | declared ref is a symbolic ref |
| `aliased_ref` | declared ref is an alias or filesystem symlink |
| `packed_ref` | storage class: the matching or mismatched ref is packed, not loose |
| `race_detected` | the two read-only snapshots disagreed |

Packed storage is evidence, not a failure: a packed protected ref that
still matches its expected SHA verifies. Missing, moved, symbolic,
aliased, hostile, and raced refs fail the receipt.

Repository kinds covered by the same comparison: local worktrees, bare
repositories, and linked worktrees. Replace refs, grafts, and shallow
files fail closed because object identity would no longer be exact.

## Content-free evidence

Receipts and typed errors never echo repository paths, URLs, credentials,
provider text, or hostile refs. Findings carry closed codes, P28
`ref_class`, a storage class, and booleans only. Verified and failed
receipts both project one P13 `git_identity` fact with method
`protected_ref_snapshot_compare` and authority `platform_git`. Failures
add one P13 `security` discrepancy (`security_boundary`), matching the
accepted P28 evidence projection.

The receipt also carries an all-false side-effect nonclaim map:
`ref_mutated`, `worktree_mutated`, `index_mutated`, `config_mutated`,
`remote_mutated`, `credentials_accessed`, `packed_refs_rewritten`.

## Composition

P30 consumes accepted surfaces and invents none of their semantics:

| Surface | Owner | Use here |
| --- | --- | --- |
| Protected/default classification, lane namespace, operation authority | P28 `git-authority.mjs` | `parseGitAuthorityPolicyV1`, `classifyRefV1`, `isProtectedRefV1`, `classifyGitOperationV1` |
| Closed inspect environment and remote-mutation denial | P29 `credential-boundary.mjs` | `GIT_INSPECT_ENV`, `denyWorkerRemoteMutation` |
| Evidence records | P13 `evidence-bundle.mjs` | `parseVerifiedFactV1` / `parseEvidenceDiscrepancyV1` |
| API, run orchestration, credential files, release, Gate A | later slices | not invoked |

P28 remains the authority-policy seam. P29 remains the credential and
remote-mutation isolation boundary. This module does not wrap either, does
not load credential files, and does not grant merge, rebase, push, PR,
tag, or protected-ref write authority. `read_only_inspect` is the only
accepted operation.

## Non-goals

No ref, worktree, index, or config mutation. No remote credential access.
No credential materialization. No GitHub, merge, rebase, push, PR, tag,
or protected/default-ref authority. No public API, run orchestration,
release, or Gate A scope.

## API

- `parseProtectedRefAuditRequestV1(request)` — quarantines the request and
  binds P28 classification without observing Git.
- `auditProtectedRefsV1(request, options?)` — async; returns a detached,
  deeply frozen receipt. `options` may inject `spawn` (test seam).
- `describeProtectedRefAuditV1()` — deterministic deep-frozen inventory of
  the schema, bounds, checks, error codes, and nonclaims.
- `PROTECTED_REF_AUDIT_SCHEMA_ID`, `PROTECTED_REF_AUDIT_VERSION`,
  `MAX_AUDIT_REFS`, `PROTECTED_REF_AUDIT_FINDING_CODES`,
  `PROTECTED_REF_AUDIT_READONLY_GIT_COMMANDS`,
  `PROTECTED_REF_AUDIT_SIDE_EFFECT_NONCLAIMS`,
  `PROTECTED_REF_AUDIT_ERROR_CODES`.

## Testing

```
node --no-warnings --test test/r1-protected-ref-audit.test.mjs \
  test/r1-protected-ref-audit-adversarial.test.mjs
```
