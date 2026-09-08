# PR-ready final decision card

Additive v3 projection of already-typed candidate, worktree, verifier, test,
CI, push, draft-PR, topology, lane, and protected-ref facts into one
immutable machine-readable card. `exact_head` and `exact_tree` bind
independently observed identities on verifier, test/CI, push, and PR
receipts; format-only SHAs and stale booleans never authorize a substituted
head or tree. Codex Desktop keeps a concise public label. The card cannot
merge.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/final-decision-card.mjs`
- `plugins/codex-co-engineer/test/r1-final-decision-card.test.mjs`
- `plugins/codex-co-engineer/test/r1-final-decision-card-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-final-decision-card-fixtures.mjs`
- this document

## Entry

```js
projectFinalDecisionCardV1(request)
```

The request is a closed JSON object. Unknown keys, provider prose, Proxies,
accessors, and forged `ready_for_sol_merge` fields fail closed before any
projection. Results are detached, deeply frozen, and JSON-serializable.

## What the card shows

- exact candidate branch, HEAD, and tree bound to current verifier, test,
  CI, push, and PR observations
- worktree cleanliness and a typed `active_git_operation` (`none` is the
  only ready value)
- verifier, test, and CI evidence plus freshness
- non-force push state
- draft PR repository, host, provider, number, open+draft state, exact
  head/tree, and target branch (a number-only or arbitrary HTTPS URL is
  not trusted)
- provider and assignment attribution; required lanes qualify only when
  explicitly accepted
- lane-scoped artifact references bound to an `assignment_id` present in
  that parsed attribution set for the exact run
- `ready_for_sol_merge` or a complete bounded list of exact blockers

Progressive disclosure keeps a compact model-facing `summary` plus
`artifacts` references for expensive diff, log, or evidence. Overflow is
never silent: `truncation` records `truncated`, `fields`, `original_count`,
`retained`, `omitted`, and `reason`.

The public `label` is `PR-ready` or `Blocked`.

## Readiness

`ready_for_sol_merge` is true only when every typed check passes and every
readiness receipt agrees on the exact candidate identity and freshness.
It is never derived from provider prose, hidden or unknown checks, stale
CI or other stale evidence, a missing topology CAS, missing verifier
acceptance, a dirty worktree, an active git operation other than `none`,
an unpublished head, a mismatched PR head, a number-only or arbitrary
HTTPS PR URL, protected-ref mutation, unresolved lanes, a required
lane that is cancelled, failed, blocked, `needs_attention`, unresolved,
`transport_lost`, `environment_blocked`, unknown, or nonterminal, or a
lane-scoped artifact whose `assignment_id` is absent from the parsed
attribution set. Ghost or unknown assignments are never projected as
trusted. The card does not infer a run-level external artifact class;
ArtifactRefV1 remains lane-scoped, and a missing `assignment_id` fails
closed. Only explicitly accepted required lanes qualify. Blockers are
the closed vocabulary in manifest order.

## Merge authority

The card never merges, pushes, rebases, creates a PR, tags, or releases.
`merge.card_can_merge` is always false. Sol High/XHigh alone may
regular-merge after exact-head, exact-tree, current-green-CI, and topology
CAS checks. Those CAS results are recorded on `merge.cas`.

## Non-goals

Server, supervisor, provider, UI, Git, network, and credential I/O stay
unowned. The card does not cut over MCP tools, mutate refs, or claim Gate A.
