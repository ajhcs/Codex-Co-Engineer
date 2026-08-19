# Control-plane reliability and full-feature utilization plan

Status: current release baseline (Co-Engineer 2.2.0; Cursor Control 0.4.0;
Cursor Local wire identity 0.2.0).
Host-specific acceptance items remain explicitly called out below.

Scope: Codex-Co-Engineer, DeepSeek Harness (DSH), Grok Build, Cursor Cloud and
Local Control, Codex-native delegation, and their lifecycle integrations.

## Outcome

The control plane should use every supported provider feature when it is useful,
while preserving four non-negotiable boundaries:

1. Required host and sandbox capabilities are proved before a provider job is
   submitted.
2. Nested workers inherit the parent's target, write ceiling, deadline, and
   provider configuration; they cannot widen them.
3. Durable jobs and receipts survive task and MCP restarts without silently
   falling back to temporary state.
4. Status and identity responses are truthful, compact, and private by default.

There should be no blanket `no_subagents` policy. Grok internal subagents should
remain enabled by default, Cursor custom subagents should be available through a
typed request, DSH delegation should be exposed when the installed DSH version
can prove support, and Codex-native subagents should be used for independent
local work. A provider that cannot report whether delegation was used must say
`unknown`, not imply success.

Configured Cursor, Grok, and DSH credentials or provider sessions are reused as
standing authorization for task-scoped work. Provider sessions can expire or be
revoked and may require ordinary provider reauthentication; the control plane
does not add per-job egress prompts or approval receipts. Repository writes,
destructive Git operations, production changes, and PR creation retain their
ordinary task authority and safety controls.

The implementation should maximize useful provider capability per model-facing
tool call. Prefer dynamic provider catalogs, installed profiles, compact presets,
and detail-on-demand over copied configuration, additional tools, or wrapper
logic that duplicates the underlying harness.

## Current baseline

This repository is the correct integration project. Its existing architecture
already provides strict target contracts, separate Co-Engineer and Cursor MCP
servers, package validation, Inspector preflights, and a repository release
gate.

The current public baseline is Co-Engineer 2.2.0 and Cursor Control 0.4.0;
the separately advertised Cursor Local wire identity is 0.2.0.
Generated runtime, state, credential, and other host-local paths remain outside
the public release artifacts.

Observed baseline behavior:

- Cursor unit and local Inspector tests pass in an ordinary task sandbox.
- Co-Engineer tests pass on the host. The installed Grok CLI owns its built-in
  sandbox contract (Landlock on Linux, Seatbelt on macOS); host-specific
  Bubblewrap probes are optional integration checks, not product readiness
  prerequisites.
- Cursor identity uses an explicit allowlist projection, so upstream personal
  identity fields are not returned by default.
- Co-Engineer promotes the diagnostic Grok authentication result into the
  top-level readiness summary so those views cannot disagree.
- Co-Engineer status returns compact recent-job summaries; exact job retrieval
  remains available for bounded configuration and lifecycle detail.
- Grok review and verify use noninteractive `auto` permission mode so blocked
  tool calls fail back to the model, while the CLI-managed `read-only` sandbox
  remains the hard write boundary.
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
| Provider account and repository access | Configured Cursor/Grok/DSH credentials or sessions | Reuse as standing authorization; report ordinary expiry, revocation, or provider errors |

## Milestone 0: preserve and classify the candidate

Move any dirty candidate to an isolated branch/worktree without rewriting it.
Inventory every hunk and assign it to a release or discard decision. Keep
unrelated local plugins and generated files outside the public release unless
their release dependency is explicitly proven.

Acceptance:

- `main` remains unchanged.
- Every retained change has an owner, intended PR, and test obligation.
- Existing sandbox preflight and Cursor timeout work is preserved; the Grok
  preflight follows the installed CLI-managed Landlock/Seatbelt contract.
- Each implementation worker has one branch/worktree and one lifecycle receipt.
- No credential file is read, copied, committed, or included in an artifact.

## Milestone 1: one truthful capability and preflight contract

Both control planes should evaluate the same sequence before dispatch:

```text
configured -> locally_usable -> provider_authenticated -> target_ready
```

Each stage returns `ready`, a stable failure code, bounded evidence, and a
specific remedy. The evaluator checks actual operation, not command presence:

- durable state creation, ownership, atomic rename, and SQLite locking;
- daemon/socket creation and connection;
- provider-managed sandbox profile and required mounts/permissions (Grok's
  Landlock profile on Linux or Seatbelt profile on macOS);
- provider CLI version and supported option vocabulary;
- a non-mutating authentication probe;
- exact Git root, immutable HEAD, worktree ownership, and allowed paths;
- confirmed repository URL and remotely visible immutable commit when required;

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

The leading candidate is Grok `auto` permission mode inside the installed CLI's
read-only sandbox profile (Landlock on Linux, Seatbelt on macOS). Validate this
against the installed CLI rather than assuming its semantics. Bubblewrap or
other host-specific custom profiles are optional future integration concerns,
not readiness prerequisites.

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
deadline, network policy, and provider profile.

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
- Internal subagents cannot expand path, write, deadline, or network authority.
- Unsupported combinations fail validation before dispatch.
- Cancellation, timeout, and parent failure reconcile every nested worker.

## Milestone 6: dynamic provider capabilities and repository integrity

Use each provider's authenticated, dynamic capability catalog as the source of
truth. Do not hard-code Cursor's model list or duplicate complete Grok/DSH
configuration in every request. Compact profiles should select installed
capabilities while allowing exact typed overrides when needed.

For repository-backed Cursor creation, validate the exact URL and require a full
remotely visible SHA for reproducible agent-mode work. Branch/PR mutation remains
a separate explicit operation because it changes repository state, not because
the provider is external.

Acceptance:

- Cursor model IDs, variants, and parameters come from the authenticated
  `/v1/models` catalog and new models require no plugin release.
- Grok profiles expose model, supported reasoning, sessions, subagents, tools,
  sandbox, memory/web, and transport without copying installed configuration.
- DSH profiles expose the effective model, tools, workflows, and delegation that
  the installed profile can actually advertise.
- Follow-ups and nested workers inherit the exact repository and target scope.
- Agent-mode Cursor runs reject non-immutable or remote-invisible starting refs.
- Provider access failures are ordinary authentication/permission errors, never
  extra model-facing egress approval prompts.

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
capability decisions, lifecycle mapping, and bounded redacted
evidence.

CI uses fake CLIs and injected HTTP only. Separately authorized live smoke tests
use non-sensitive fixtures with strict cost and time bounds.

Required matrix dimensions:

| Dimension | Required cases |
| --- | --- |
| Runtime | DSH, Grok, Cursor, Codex-native delegation |
| Role | plan, review, verify, implement |
| Delegation | unsupported, disabled, enabled, nested |
| Sandbox | normal, home read-only, socket denied, CLI-managed profile unavailable, custom-profile integration unavailable |
| State | fresh, existing, unwritable, restart, corrupt, concurrent writers |
| Git | clean, dirty, protected `.git`, wrong HEAD, remote SHA absent |
| Authentication | absent, invalid, ready, expired |
| Provider auth | absent, invalid, ready, expired, revoked standing credential |
| Lifecycle | success, product failure, environment block, timeout, cancel, transport loss, uncertain submission |
| Upgrade | idle, active-task, rollback, garbage collection |
| Privacy | PII identity, secrets in errors/events, oversized status |

Final release acceptance:

- The fake/integration matrix passes under the same workspace-write sandbox used
  by Codex.
- A bounded live smoke using configured standing provider authorization proves read-only review with internal
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
7. Add dynamic provider catalogs, remote-SHA attestation, and installed schema tests.
8. Add upgrade leases/stable activation fixtures and link the Codex app change.
9. Unify lifecycle receipts and enable the full certification/release gate.

Each PR should be independently reviewable, must preserve unrelated dirty work,
and must include its failure-path tests. Provider-backed tests are never part of
unattended CI; separately authorized live smoke tests use configured accounts.
