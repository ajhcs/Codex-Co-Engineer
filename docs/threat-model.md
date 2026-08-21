# Codex and worker authority

- Status: Accepted
- Date: 2026-08-21
- Product version: 3.3.0
- Complements: [ADR 0001](adr/0001-r1-bounded-run-architecture.md)
- Runtime: specified here; not implemented by this document

This is the honest threat model and authority split for R1. It does not
claim a sandbox Codex-Co-Engineer does not have.

## Authority

Codex is the only final acceptance and integration authority. Codex
decides whether a run's commits, receipts, and any run-owned candidate are
accepted, discarded, pushed, opened as a pull request, or merged.

Provider workers are trusted peer coding agents for one assigned lane.
Selecting Grok, Cursor Local, Cursor Cloud, or DSH authorizes that
provider to receive the task prompt and the repository material needed for
the assignment. Workers may use their normal shell, dependency
installation, and coding capabilities inside that lane. They are not merge
authorities, credential brokers, or policy engines.

The platform supervisor records exact identities, launches owned local
process groups or remote cloud runs, preserves evidence, and may compose a
non-authoritative candidate. It does not integrate into a user or
protected branch, mutate a remote on Codex's behalf, or treat worker
success as product acceptance.

`create_pr` remains Cursor Cloud-only and is still not merge authority.
Local workers return commits and handoff evidence for Codex.

## Repository exposure

A selected provider receives the **full repository** reachable from the
assigned worktree or from the Cursor Cloud origin and `starting_ref`.
That includes files that were accidentally committed: source, history
present in the sent object set, fixtures, and secrets that landed in Git
by mistake.

Do not delegate a repository the provider is not authorized to process.
Rotate any secret that was committed and then sent.

Platform-protected material is **not** part of that repository grant and
must remain excluded from provider payloads, prompts, MCP arguments, and
task records:

- platform and provider control credentials, including owner-only key
  files and process environment secrets;
- protected refs and other refs the operator did not grant;
- control-plane tokens, MCP session tokens, and supervisor lock secrets;
- raw owner-only task state that is not the assigned workspace.

The platform must not copy those excluded classes into a worktree, prompt,
or provider origin URL in order to make a task "easier."

## Cgroups are lifecycle control, not a sandbox

Local workers launch as manager-owned transient `systemd --user` services
with `KillMode=control-group`. That boundary exists so cancellation can
reach detached descendants and so the worker can survive the launching
client.

It is not a sandbox. It does not restrict the provider's environment,
credentials, network, filesystem, or shell capabilities. Local dispatch
fails closed when Linux `systemd --user`, `systemd-run` 244 or newer, or
unified cgroup v2 cannot be verified. Treat the local Unix account as
inside the trusted boundary.

Cursor Cloud runs in the provider's remote environment and does not use
the local cgroup.

## Evidence classes

Two evidence classes exist and must not be mixed:

| Class | Audience | Contents |
| --- | --- | --- |
| Raw evidence | Owner-only, local host | Full `events.jsonl`, prompts, worker logs, runtime files, unredacted provider output, local paths. Stored under the owner-only state root with `0700` directories and `0600` files. |
| Sanitized bounded evidence | Model-facing coordination | Secret-redacted, size-capped receipts, compact/summary projections, diagnostic pages, and bounded terminal verdicts. |

Codex should use sanitized bounded evidence for routine `decision_or_attention`.
Raw evidence stays on the owner host for inspection, incident response, and
proof-bound cleanup. It is not a model context dump and is not published.

Live receipts may still contain bounded agent output and code context.
Treat them as private state. Public MCP receipts continue to redact
secrets in `result`, errors, nested handoff/validation, and events.

## Trusted verification policy

Verification lanes are read-only. The **trusted verification policy** is
the only executable command catalog those lanes may run. A verifier may
not:

- invent commands outside the catalog;
- install additional trust roots or mutate the workspace;
- treat a model-suggested command as authorized;
- follow a worker-supplied script that is not an exact catalog entry.

Gate A functional release checks remain the product's executable release
catalog. Advisory Gate B and Gate C measurements, when recorded, are not
an additional command grant.

## Cleanup and retention

Terminal managed runs retain worktrees, branches, locks, and task state
until the operator deliberately removes an **exact** identified object.
That retention is evidence preservation, not leakage into later runs.

Manual run cleanup is **proof-bound**:

1. Inspect the receipt, handoff, and writer lock.
2. Clean only the exact lock ID with the documented `worktree-bootstrap`
   policy.
3. Remove only the corresponding worktree, branch, and terminal task-state
   directory after the receipt is no longer needed.

There is **no automatic garbage collection** of runs, worktrees, branches,
locks, or task state. Failed bootstrap still does not authorize guessing
at or deleting an unknown worktree.

This manual cleanup path is allowed. First-release non-goals forbid
automatic GC; they do not forbid proof-bound operator cleanup.

## Attention, cancellation, and unsupported replies

`AttentionBatchV1` is the only run-level decision surface. Routine
progress is suppressed. Unaffected lanes continue. At most one execution
reply round is permitted.

When DSH or Cursor Cloud asks a question the same-session reply path does
not support, the question becomes unresolved and the affected assignment
is safely cancelled. Cancellation uses the owned local process group or
the remote cloud run. Prompt-dispatched work is never replayed to "try
the question again."

## What this model does not provide

- Isolation from a selected provider that has the repository.
- Confidentiality for secrets already committed to that repository.
- A capability sandbox around local worker shells.
- Cross-run memory, search, or learned routing.
- Automatic repair, consensus, or protected-branch integration.
- Automatic GC.

Workers remain powerful inside their lane because they are peer coding
agents. The mitigation is exact scope, exact identity, Codex-only
integration, bounded model-facing evidence, and proof-bound cleanup — not
a claim that the provider is jailed.

## Stable contract identifiers

Machine-checked authority and threat-model identifiers:

- `codex_only_final_acceptance`
- `full_repository_provider_exposure`
- `platform_protected_credentials_refs_tokens_excluded`
- `cgroup_lifecycle_not_sandbox`
- `raw_evidence_owner_only_local`
- `sanitized_bounded_evidence_model_facing`
- `trusted_verification_policy_command_catalog`
- `manual_proof_bound_cleanup`
- `no_automatic_gc`

These identifiers do not forbid `run_owned_candidate_composition` or
`manual_proof_bound_cleanup`.
