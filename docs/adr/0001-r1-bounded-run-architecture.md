# ADR 0001: R1 bounded-run architecture

- Status: Accepted
- Date: 2026-08-21
- Product version: 3.3.0
- Compatibility: additive with Codex-Co-Engineer 3.2.1
- Runtime: specified here; not implemented by this document

This is the stable architecture decision for R1. Later 3.3.0 runtime work
must implement this contract rather than reinterpret it.

## Context

Codex-Co-Engineer 3.2.1 already lets Codex delegate 1–8 independent tasks,
wait without routine text wakeups, and inspect bounded receipts. It does not
define a first-class **run**: one submitted unit of work with one immutable
repository identity, disjoint writer scopes, read-only verification, and a
single Codex-owned acceptance decision.

R1 ships as **3.3.0**. It adds a bounded run on top of the 3.2.1 five-tool
catalog. It is not a rewrite of the supervisor, and it does not replace
Codex as reviewer or merge authority.

## Decision

A 3.3.0 run is 1–8 independent assignments against one immutable
repository/base identity. Assignment fields resolve deterministically from
explicit values or a named profile. Run submissions never use direct mode.
Writer scopes are disjoint. Verification is read-only. After prompt
dispatch there is no fallback or replay. Identities are exact. Evidence is
bounded. Codex alone accepts and integrates. Frozen verified child deltas
may be composed into one non-authoritative run-owned candidate; that
candidate is never the integration authority.

## Run identity and bounds

A run is one submitted coordination unit:

- `assignment_count` is an integer in `1..=8`.
- Every assignment in the run shares one repository identity and one
  immutable base commit SHA. The platform does not retarget a live run onto
  a different repository, branch name, or moving ref.
- Run, assignment, worktree, branch, lock, commit, and receipt identifiers
  are exact caller- or platform-issued values. The platform does not guess,
  rewrite, or substitute a nearby identity.
- The five-tool MCP catalog remains `status`, `delegate`, `task`, `tasks`,
  and `cancel`. A run is a coordination record over assignments, not a sixth
  tool.

Independent means the submitted scopes do not share a writer path and do
not require another assignment's uncommitted mutation. Cross-assignment
collaboration, debate, and dynamic spawning are out of scope.

## Deterministic explicit or profile resolution

Each assignment is fully resolved before dispatch:

1. Explicit assignment fields win when present.
2. Omitted fields may be filled from one named profile.
3. Profile lookup is a deterministic table/file resolution. It is not an
   LLM choice, learned router, or cost predictor.
4. Resolution failure is a pre-dispatch error. The platform does not
   substitute a different provider, model, role, or scope.

A profile may name provider, role, expected duration, and a verification
command catalog. It may not name credentials, moving refs, or a direct-mode
workspace.

## No direct mode for run submissions

3.2.1 single-task `delegate` continues to accept explicit
`workspace_mode: "direct"` for additive compatibility.

R1 **run submissions** reject direct mode. Every local writer assignment in
a run uses a managed `worktree-bootstrap` worktree, branch, and writer
lock. Cursor Cloud assignments continue to use a provider-accessible origin
plus an exact already-pushed `starting_ref` SHA; they still do not mutate
the caller's checkout.

## Disjoint writer scopes

Writer assignments own disjoint path scopes. The platform rejects a run
whose writer scopes overlap before dispatch. One writer remains the only
mutator of its worktree and branch:

```text
one assignment -> one worktree -> one branch -> one writer
```

A required writer lane that is rejected or left unresolved blocks a
complete run-owned candidate. Unaffected lanes may continue; they do not
inherit the failed lane's scope.

## Read-only verification

Verification assignments are read-only. They inspect declared worktrees,
commits, and receipts. They do not create commits, push, open pull
requests, or edit protected refs.

The **trusted verification policy** is the only executable command catalog
for verification lanes. A verifier may run only those exact commands. It
may not invent shell, package, or network actions outside that catalog.

## Transport, fallback, and replay

Local writer assignments use ACP first. A same-provider CLI fallback is
permitted only when ACP fails **before** prompt dispatch. After a prompt is
accepted for dispatch, the assignment is reconciled, cancelled, or failed;
it is never replayed and never switched onto another transport or model.

DSH ACPX remains `dispatch_uncertain` after spawn and is never replayed
through CLI. Explicit Ox Alpha tasks continue to fail closed before
dispatch when ACPX cannot start.

## Exact identities and bounded evidence

Callers address runs and assignments by exact IDs. Receipts name exact
SHAs, lock IDs, worktree paths, and provider identifiers. The platform does
not accept "latest", branch nicknames, or fuzzy matches as identities.

Evidence exposed on the coordination surface is size-bounded and
secret-redacted. Compact/summary views remain the routine projection.
Diagnostics remain side-effect free, cursor-paged, and byte-capped. The
platform does not wake Codex on routine text deltas, tool chatter, or
heartbeats.

Raw local evidence stays owner-only on the host. Model-facing evidence is
the sanitized bounded projection. That split is part of the threat model,
not an implementation detail.

## Candidate composition

The platform **MAY** deterministically compose frozen verified child deltas
into one run-owned candidate. That permission is explicit and is not a
first-release non-goal.

Composition rules:

- Inputs are frozen, already-verified child deltas from the run's writer
  assignments.
- Application is exact and non-conflict-resolving. A patch that does not
  apply cleanly fails composition; the platform does not merge, rebase, or
  semantically repair conflicts.
- The result is **one** candidate with **one** parent: the run's immutable
  base SHA.
- The candidate is **run-owned** and **non-authoritative**. It is evidence
  for Codex, not an integration.
- The platform **MUST NOT** integrate that candidate into a user branch, a
  protected branch, or a remote.
- A required writer lane that is rejected or unresolved blocks a complete
  candidate. Optional/advisory lanes do not.

Codex may accept, reject, or ignore the candidate after inspection. Workers
and the composition step have no merge authority.

## `decision_or_attention` semantics

Runs coordinate through `decision_or_attention`, not through routine
progress:

- Routine progress is suppressed. Text deltas, ordinary tool traces, and
  heartbeats do not wake Codex.
- When any assignment needs a decision, the platform emits one atomic
  `AttentionBatchV1` for the run. Partial or racy attention pages are not a
  coordination surface.
- Unaffected lanes continue executing while the batch is outstanding.
- The run allows **at most one execution reply round**. A delivered reply
  is exactly-once for that batch. There is no debate loop and no automatic
  repair cycle.
- Providers that cannot host a same-session reply, including DSH and
  Cursor Cloud, do not start a new prompt. Unsupported questions become
  **unresolved** and the affected assignment is **safely cancelled**. The
  unresolved state blocks a complete candidate when the lane is required.

3.2.1 same-session `task.reply` remains valid for individual Grok and
Cursor Local tasks outside a run. A run does not lower that capability into
an unbounded Q&A channel.

## Acceptance and integration

Codex is the only final acceptance and integration authority. Provider
workers may commit inside their assigned isolated scope. The platform may
produce the non-authoritative run-owned candidate described above. Neither
action integrates into a user or protected branch, opens an authoritative
pull request for a local run, or merges to a remote.

`create_pr` remains Cursor Cloud-only and is still not merge authority.
Local run handoff stays on the managed worktree for Codex to inspect.

## Release gates

3.3.0 separates three gates. Only Gate A is the functional release
authority.

| Gate | Name | Role |
| --- | --- | --- |
| A | Functional release | Authoritative. The existing provider-free local exact-tree gate, package inventory, and additive 3.2.1 contract checks. 3.3.0 ships only when Gate A passes. |
| B | Context-efficiency | Advisory. Token/context measurements must not block Gate A. |
| C | Credit economics | Advisory. Provider-credit or cost measurements must not block Gate A. |

Gate B and Gate C may be recorded as evidence. They are not reasons to
renumber the release, withhold a Gate A-passing 3.3.0, or introduce a
learned optimizer.

## Additive 3.2.1 compatibility

3.3.0 is additive:

- The public package identifier remains `codex-co-engineer`.
- The five-tool catalog, omitted-mode 3.1.1 text duplication, optional
  structured transport, compact views, wait-any of 1–8 exact task IDs, DSH
  Muse default, and explicit Ox Alpha selector remain.
- Single-task `delegate` with `workspace_mode: "direct"` remains available
  outside run submissions.
- Existing receipts, deadline math, no-replay rules, and Codex merge
  authority remain.

R1 must not require callers to abandon 3.2.1 single-task flows.

## First-release non-goals

The following are **out of scope** for 3.3.0. They are not partially
implemented, previewed, or implied by candidate composition.

- Semantic or vector memory.
- Cross-run knowledge or search.
- LLM global compression.
- Learned routing or cost prediction.
- General DAG or branch inheritance.
- Agent messaging or dynamic spawning beyond the submitted 1–8 assignments.
- Debate, consensus, or automatic repair.
- Protected-branch integration.
- Automatic garbage collection of runs, worktrees, branches, or task state.

These non-goals do **not** forbid:

- Deterministic composition of frozen verified child deltas into one
  run-owned, single-parent, non-authoritative candidate.
- Manual, proof-bound run cleanup of an exact identified run, task, lock,
  worktree, branch, or terminal state directory.

## Consequences

- Implementers add a run record and assignment lanes without a sixth MCP
  tool and without changing 3.2.1 default response shapes.
- Verification policy becomes an executable allowlist, not a prompt
  suggestion.
- Attention is batched per run; Codex is not a per-delta supervisor.
- A composed candidate is a convenience for review. Missing or rejected
  required writers mean there is no complete candidate.
- Cleanup stays operator-driven and evidence-preserving until an exact
  identity is deliberately removed.

## Stable contract identifiers

Machine-checked 3.3.0 architecture identifiers:

- `bounded_run_1_to_8`
- `immutable_repo_base_identity`
- `deterministic_explicit_or_profile_resolution`
- `no_direct_mode_for_run_submissions`
- `disjoint_writer_scopes`
- `read_only_verification`
- `no_post_dispatch_fallback_or_replay`
- `exact_identities`
- `bounded_evidence`
- `codex_only_final_acceptance`
- `additive_3_2_1_compatibility`
- `run_owned_candidate_composition`
- `attention_batch_v1`
- `gate_a_functional_release`
- `gate_b_advisory_context_efficiency`
- `gate_c_advisory_credit_economics`

Machine-checked first-release non-goal identifiers:

- `semantic_or_vector_memory`
- `cross_run_knowledge_or_search`
- `llm_global_compression`
- `learned_routing_or_cost_prediction`
- `general_dag_or_branch_inheritance`
- `agent_messaging_or_dynamic_spawning_beyond_submitted_8`
- `debate_consensus_or_automatic_repair`
- `protected_branch_integration`
- `automatic_gc`

Machine-checked first-release allowed mechanisms, which non-goals must not
forbid:

- `run_owned_candidate_composition`
- `manual_proof_bound_cleanup`
