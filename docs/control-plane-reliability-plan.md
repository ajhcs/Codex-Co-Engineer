# Control-plane reliability and full-feature utilization plan

Status: proposed implementation plan

Scope: Codex-Co-Engineer, DeepSeek Harness (DSH), Grok Build, Cursor Cloud
Control, Codex-native delegation, and their lifecycle integrations.

## Outcome

The control plane should use every supported provider feature when it is useful,
while preserving four non-negotiable boundaries:

1. Required host and sandbox capabilities are proved before a provider job is
   submitted.
2. Nested workers inherit the parent's target, write ceiling, deadline, and data
   egress authorization; they cannot widen them.
3. Durable jobs and receipts survive task and MCP restarts without silently
   falling back to temporary state.
4. Status and identity responses are truthful, compact, and private by default.

There should be no blanket `no_subagents` policy. Grok internal subagents should
remain enabled by default, Cursor custom subagents should be available through a
typed request, DSH delegation should be exposed when the installed DSH version
can prove support, and Codex-native subagents should be used for independent
local work. A provider that cannot report whether delegation was used must say
`unknown`, not imply success.

“Use the full feature set” does not silently authorize repository writes,
network access, private-repository egress, provider memory, or PR creation.
Those capabilities remain explicit and receipted.

## Current baseline

This repository is the correct integration project. Its existing architecture
already provides strict target contracts, separate Co-Engineer and Cursor MCP
servers, package validation, Inspector preflights, and a repository release
gate.

The current `main` working tree is an unfinished mixed candidate: Co-Engineer
2.0.3 and Cursor 0.1.1 changes are present alongside an untracked `inline-keys`
plugin. That work must be preserved and attributed before further changes; it
must not be reset, silently folded into a new release, or treated as a clean
baseline.

Observed baseline behavior:

- Cursor unit and local Inspector tests pass in an ordinary task sandbox.
- Co-Engineer tests pass on the host, but nested process and Bubblewrap probes
  fail inside the ordinary workspace sandbox. Those are environment capability
  failures, not product-test failures.
- Cursor identity returns the upstream identity object after secret redaction,
  so personal name and email fields can still reach model context.
- Co-Engineer diagnostics can report Grok ready while the top-level summary says
  it is not ready.
- Co-Engineer status returns full recent-job configurations and lifecycle
  histories.
- Grok review and verify force plan permission mode, which prevents normal
  read-only terminal inspection even though the outer sandbox is read-only.
- Durable state defaults beneath `~/.local/state`, which a workspace-only task
  sandbox may not be able to write.
- Cursor repository items are typed in source, but the installed Codex tool can
  still expose them as `Array<unknown>`.
- Versioned plugin cache eviction can invalidate skill paths held by active
  tasks. Cache retention and task catalog refresh are Codex app/plugin-manager
  responsibilities, not solely repository code.

## Ownership boundaries

| Area | Primary owner | This repository's responsibility |
| --- | --- | --- |
| Co-Engineer and Cursor MCP behavior | This repository | Implement and test directly |
| Provider capability detection | This repository | Probe installed versions and report requested/effective features |
| Durable broker configuration | Repository + host installer | Define contract, bootstrap, permissions, migration, and tests |
| `agentctl` and worktree-bootstrap state defaults | Their component owners | Supply shared contract and linked acceptance tests |
| Plugin cache retention and task leases | Codex app/plugin manager | Supply a reproducible fixture and app-visible acceptance test |
| Private repository transfer to Cursor | User/administrator policy | Require a durable, target-bound egress grant before submission |

## Milestone 0: preserve and classify the candidate

Move the existing dirty candidate to an isolated branch/worktree without
rewriting it. Inventory every hunk and assign it to a release or discard decision.
Keep `inline-keys` separate unless its release dependency is explicitly proven.

Acceptance:

- `main` remains unchanged.
- Every retained change has an owner, intended PR, and test obligation.
- Existing Bubblewrap preflight and Cursor timeout work is preserved.
- Each implementation worker has one branch/worktree and one lifecycle receipt.
- No credential file is read, copied, committed, or included in an artifact.

## Milestone 1: one truthful capability and preflight contract

Both control planes should evaluate the same sequence before dispatch:

```text
configured -> locally_usable -> provider_authenticated -> target_ready -> egress_authorized
```

Each stage returns `ready`, a stable failure code, bounded evidence, and a
specific remedy. The evaluator checks actual operation, not command presence:

- durable state creation, ownership, atomic rename, and SQLite locking;
- daemon/socket creation and connection;
- Bubblewrap namespaces and required mounts;
- provider CLI version and supported option vocabulary;
- a non-mutating authentication probe;
- exact Git root, immutable HEAD, worktree ownership, and allowed paths;
- confirmed repository URL and remotely visible immutable commit when required;
- applicable external-data authorization.

Acceptance:

- A failed prerequisite creates no provider job or partial writer state.
- Failures are classified as `environment_blocked` or `approval_required`, not
  as product or test failures.
- Status and dispatch use the same evaluator and cannot disagree.
- Supported reasoning levels and subagent modes are derived from installed
  provider capabilities; unsupported values fail before job creation.

## Milestone 2: sandbox-safe durable state and transport

Introduce a host-provisioned state root shared by lifecycle components:

```text
CODEX_TASK_STATE_ROOT/
  agentctl/
  worktree-bootstrap/
  codex-co-engineer/
  cursor-cloud-control/
```

Resolution order:

1. component-specific explicit state variable;
2. host-injected `CODEX_TASK_STATE_ROOT`;
3. a verified writable XDG state root;
4. fail closed with a remedy.

Temporary state is allowed only in an explicit test/ephemeral mode and must be
reported as non-durable. The Co-Engineer daemon should be host-owned or reached
through an explicitly granted endpoint; a sandboxed facade should not discover
socket denial only after submission.

Acceptance:

- All four lifecycle components work from a normal workspace-write task with an
  unwritable home directory and no per-command overrides.
- Directories and ledgers retain owner-only permissions and reject symlinks or
  unsafe modes.
- Receipts, request IDs, and job visibility survive MCP and task restart.
- Unwritable state, socket denial, corrupt state, and stale locks fail before a
  provider request with one actionable diagnosis.
- No component reports temporary state as durable.

## Milestone 3: private and compact response contracts

Cursor identity should use an allowlist projection by default:

```json
{"authenticated": true, "userId": "opaque-provider-id", "keyStatus": "valid"}
```

Unknown upstream fields are dropped. Full identity, if retained at all, requires
both an administrator process policy and an explicit per-call flag, and should
prefer an administrative UI over model context.

Co-Engineer should use a compact job summary for status and list operations.
Full configuration, target context, and bounded lifecycle remain available only
from exact job retrieval. Diagnostic Grok authentication and sandbox results
must be promoted into the top-level readiness summary for that response.

Acceptance:

- A fake identity containing name, email, avatar, organization, and unknown
  fields emits none of them by default.
- A request flag alone cannot expose personal identity.
- Diagnostic and top-level readiness values are internally consistent.
- Three recent job summaries remain below 8 KiB.
- Status/list contain no prompt, full target contract, effective configuration,
  or lifecycle history; exact job retrieval remains sufficient for diagnosis.

## Milestone 4: terminal-capable read-only review

Separate provider workflow mode from filesystem authority. Grok review and
verify require a terminal-capable, noninteractive execution envelope with:

- the repository readable but not writable;
- disposable writable home, temporary, and XDG directories;
- explicit network policy;
- pre/post Git and filesystem snapshots;
- zero repository mutation as a hard postcondition.

The leading candidate is Grok `auto` permission mode inside the connector's
read-only Bubblewrap target. Validate this against the installed CLI rather than
assuming its semantics.

Acceptance:

- Review can run `git status`, `git diff`, `rg`, and file reads.
- Writes to tracked, untracked, Git-administrative, and out-of-scope paths fail.
- Scratch output is confined to disposable state and removed afterward.
- Any observed repository mutation terminates as `read_only_violation`.
- Implement jobs retain one authorized worktree writer and final scope checks.

## Milestone 5: provider and native subagent profiles

Represent delegation as an observable capability:

```text
subagents.supported
subagents.requested
subagents.effective
subagents.restriction_inheritance
```

Profiles should cover at least `review`, `verify`, `implement`, and
`parallel-review`. A nested worker inherits target, allowed paths, write ceiling,
deadline, network policy, and egress grant.

Provider behavior:

- Grok: omit `no_subagents` by default; test both enabled and explicit disable.
- Cursor: preserve typed, bounded `customSubagents`; report a non-sensitive
  count/digest and the current nested-stream limitation.
- DSH: expose internal delegation only when capability detection proves it;
  otherwise report `unknown` or `unsupported`.
- Codex native: use subagents for independent local analysis and testing, with
  one writer per worktree.

Acceptance:

- Receipts state supported, requested, enabled/effective, and restriction
  inheritance without storing subagent prompts.
- Internal subagents cannot expand path, write, deadline, network, or egress
  authority.
- Unsupported combinations fail validation before dispatch.
- Cancellation, timeout, and parent failure reconcile every nested worker.

## Milestone 6: Cursor egress and repository attestation

Require a durable authorization record bound to provider, normalized repository
URL, public/private classification, exact commit SHA, allowed data classes,
operation class, expiry/revocation, and approving actor. The prompt is never an
authorization record.

Before repository-backed Cursor creation, validate the exact URL, require a full
SHA for agent mode, confirm the SHA is visible in the intended remote, and match
an active egress grant. Branch/PR mutation remains a separate explicit choice.

Acceptance:

- Missing, stale, or mismatched authorization returns `approval_required`
  before Cursor is contacted or a mutation ledger entry is created.
- A grant for one provider, repository, or SHA cannot authorize another.
- Follow-ups and custom subagents cannot broaden the grant.
- Private-repository transfer is stated plainly in the receipt.
- Live private-repository tests remain manually gated and use disposable
  branches with automatic PR creation disabled by default.

## Milestone 7: installed schemas and task-safe upgrades

Test the schema that Codex actually sees after plugin activation, not only the
source validator. Cursor `repos.items` must expose `url`, `startingRef`, and
`prUrl` to generated clients.

Adopt staged plugin installation and atomic activation with task leases:

```text
plugins/cache/<plugin>/<version>/
plugins/active/<plugin> -> selected version
active task lease -> exact immutable version
```

New tasks receive the activated version; active tasks retain their leased
version until completion. Garbage collection must not remove leased versions.

Acceptance:

- MCP Inspector and a generated-client fixture both see typed repository items,
  never `Array<unknown>`.
- Upgrading N to N+1 does not break a paused task using N.
- New tasks use N+1, rollback is atomic, and crash recovery reconstructs leases
  conservatively.
- A fresh Codex task verifies the activated skill path and tool schema.

The lease/cache implementation is an upstream Codex app requirement. This
repository owns the fixture, packaging discipline, activation smoke test, and
evidence needed to close that upstream issue.

## Milestone 8: lifecycle evidence and certification

Use `agentctl` as the orchestration receipt and provider ledgers as adapters.
Every external or native worker maps to one accountable receipt containing
stable request/provider IDs, target and configuration digests, worktree receipt,
capability and egress decisions, lifecycle mapping, and bounded redacted
evidence.

CI uses fake CLIs and injected HTTP only. Separately authorized live smoke tests
use non-sensitive fixtures with strict cost and time bounds.

Required matrix dimensions:

| Dimension | Required cases |
| --- | --- |
| Runtime | DSH, Grok, Cursor, Codex-native delegation |
| Role | plan, review, verify, implement |
| Delegation | unsupported, disabled, enabled, nested |
| Sandbox | normal, home read-only, socket denied, Bubblewrap missing, namespaces denied |
| State | fresh, existing, unwritable, restart, corrupt, concurrent writers |
| Git | clean, dirty, protected `.git`, wrong HEAD, remote SHA absent |
| Authentication | absent, invalid, ready, expired |
| Egress | public policy, private pending, approved, expired, revoked |
| Lifecycle | success, product failure, environment block, timeout, cancel, transport loss, uncertain submission |
| Upgrade | idle, active-task, rollback, garbage collection |
| Privacy | PII identity, secrets in errors/events, oversized status |

Final release acceptance:

- The fake/integration matrix passes under the same workspace-write sandbox used
  by Codex.
- A separately authorized live smoke proves read-only review with internal
  delegation and one bounded implementation for each supported provider.
- No live smoke requires an ad hoc state override or manual unsandboxed daemon.
- Status is compact, private, and internally consistent.
- Restart, timeout, cancellation, and uncertain submission reconcile without
  duplicate jobs.
- Installation, hot upgrade, task restart, rollback, and active-task leases
  preserve usable control-plane state.

## Proposed PR sequence

1. Preserve/classify the current 2.0.3 and 0.1.1 candidate; add regression
   fixtures and forward the Cursor repository-timeout setting from its manifest.
2. Add the shared state-root and capability result contract.
3. Make Co-Engineer transport/readiness sandbox-safe and restart-durable.
4. Add compact status, diagnostic promotion, PII-safe Cursor identity, and
   response budgets.
5. Repair Grok read-only terminal review and capability-derived reasoning modes.
6. Add provider/native subagent capability profiles and inheritance tests.
7. Add Cursor egress grants, remote-SHA attestation, and installed schema tests.
8. Add upgrade leases/stable activation fixtures and link the Codex app change.
9. Unify lifecycle receipts and enable the full certification/release gate.

Each PR should be independently reviewable, must preserve unrelated dirty work,
and must include its failure-path tests. Provider-backed tests and private data
egress are never part of unattended CI.
