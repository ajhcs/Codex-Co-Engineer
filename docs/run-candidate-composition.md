# Run-owned candidate composition (P35)

P35 deterministically composes frozen verified child deltas into one
run-owned, single-parent, non-authoritative candidate and verifies that
candidate through accepted P13/P14/P15/P16/P30/P32 evidence. It does not
own the server, supervisor, worker, provider, registry, runtime,
scheduler, artifact-bridge, or release surfaces. Codex retains sole final
acceptance and integration authority.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/run-candidate-composer.mjs`
- `plugins/codex-co-engineer/mcp/v3/run-combined-verifier.mjs`
- `plugins/codex-co-engineer/test/r1-run-candidate-composer.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-candidate-composer-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-combined-verifier.test.mjs`
- `plugins/codex-co-engineer/test/r1-run-combined-verifier-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-run-candidate-composer-fixtures.mjs`
- this document

## Composition

```js
composeRunOwnedCandidateV1(request, options?)
```

The request names the composer schema/version, a credential-free run/base
identity, the expected base ref, declared protected/default refs, and 1–8
lanes in **manifest order**. Optional
`allow_diagnostic_partial_candidate` is a permission, never an obligation.

Eligible inputs are frozen, already-verified writer deltas. Each eligible
child head SHA is frozen, a binary-safe tree delta is computed from the
immutable run base, and eligible deltas are applied in manifest order onto
a disposable index. Application uses Git plumbing (`read-tree`,
`update-index --index-info`, `write-tree`, `commit-tree`, `update-ref`)
so NUL bytes and other non-text payloads survive without recoding.

Before application the composer revalidates:

- path ownership against the lane `write_scope` and sibling writer scopes
- Git policy: symlink, submodule, rename, copy, and mode-change deltas
  are rejected
- P28 `compose_candidate_non_authoritative` authority on
  `refs/codex-co-engineer/runs/<run-id>/candidate`
- P30 live protected/default refs against the declared identities

A patch that does not apply cleanly, or two writers that claim the same
path, fails closed. The platform does not merge, rebase, three-way apply,
or semantically repair conflicts.

The result is **one** candidate with **one** parent: the run's immutable
base SHA. The only ref written is
`refs/codex-co-engineer/runs/<run-id>/candidate`. HEAD, the default
branch, tags, remotes, and user-protected refs are not mutated. Restart of
the same frozen deltas is idempotent: the same tree, parent, author, and
message produce the same candidate SHA.

## Completeness

| Lane | Missing, rejected, or unresolved | Effect |
| --- | --- | --- |
| Required writer (`implement` / `writer`) | yes | blocks a complete candidate |
| Optional/advisory (`review` or `verify` / `read_only`) | yes | does not block |

A required writer that is rejected or unresolved blocks `composed`. When
`allow_diagnostic_partial_candidate` is true, verified writers may still
be applied, but the receipt is `incomplete_candidate` and
`ready_for_codex_review` stays false. Absent or false diagnostic
authorization keeps complete-only behavior: no candidate ref is written.

The composer never sets `ready_for_codex_review`. Diagnostic partial
output is `incomplete_candidate` and can never receive that authorization.

## Combined verification

```js
verifyCombinedCandidateV1(request, options?)
```

The verifier consumes a composition receipt as values and verifies the
candidate through accepted evidence:

| Surface | Owner | Use here |
| --- | --- | --- |
| Evidence records | P13 `evidence-bundle.mjs` | `parseVerifiedFactV1` / `parseEvidenceDiscrepancyV1` |
| Git identity | P14 `git-identity.mjs` | `verifyGitIdentityV1` |
| Scope / read-only / merge-commit | P15 `scope-verifier.mjs` | `verifyScopeV1` |
| Constrained trusted-policy execution | P16 `constrained-verification-runner.mjs` | injected `executeVerification` |
| Live protected-ref audit | P30 `protected-ref-audit.mjs` | `auditProtectedRefsV1` |
| Run API boundary | P32 `run-api-boundary.mjs` | `projectRunApiBoundaryV1` of already-produced P30/P31 receipts |
| Git authority | P28 `git-authority.mjs` | exact same-run candidate-ref authority |

The verifier revalidates `composition.candidate_ref` through accepted P28
run-owned candidate-ref authority bound to the same run and composition
receipt identity. Regex or presence is not authority. The only accepted
name is `refs/codex-co-engineer/runs/<same-run-id>/candidate` from
`expectedCandidateRefV1` / `isRunOwnedCandidateRefV1` plus a
`compose_candidate_non_authoritative` verdict whose projected evidence
repeats that same run/assignment/base. Unauthorized names include
`refs/heads/main`, other heads, tags, remotes, notes, protected and
default refs, another run's candidate, malformed, nested, escaped,
traversal-like, and symbolic or aliased refs. Missing or contradictory
P28 evidence fails closed. An unauthorized ref never returns
`verified` or `ready_for_codex_review`; the receipt is deterministic
frozen `failed` evidence with no Git or remote mutation.

`ready_for_codex_review` is true only when composition is complete
(`composed`, one parent), the candidate ref is the exact P28 same-run
binding, P14/P15/P30 verify, P32 projects `ready`, and P16 reports an
unchanged passing execution. Incomplete diagnostic candidates, blocked
required lanes, missing P16 evidence, and any failed audit remain not
ready. Codex still owns acceptance: a verified receipt is evidence for
review, not integration.

## Receipts

Composer and verifier receipts are detached and deeply frozen. They name
exact run/assignment identity, the candidate ref, parent SHA/count,
applied and blocked lanes, checks, P13 facts, and an all-false
side-effect nonclaim map. They never echo credentials, repository paths,
URLs, provider text, or hostile refs. `integrated`, `remote_mutated`,
`push_performed`, `merge_performed`, `pr_created`, and `tag_created` stay
false.

## Non-goals

No server, supervisor, worker, provider, registry, runtime, scheduler, or
artifact-bridge wiring. No merge, rebase, push, PR, tag, release, or
protected/default-ref mutation. No conflict repair. No Gate A or version
claim. Cleanup of the candidate ref is not automatic.

## Testing

```
node --no-warnings --test test/r1-run-candidate-composer.test.mjs \
  test/r1-run-candidate-composer-adversarial.test.mjs \
  test/r1-run-combined-verifier.test.mjs \
  test/r1-run-combined-verifier-adversarial.test.mjs
```
