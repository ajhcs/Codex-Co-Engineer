# Release process

The authoritative gate runs once against one exact clean local candidate:

```sh
release-gate plan --repo "$PWD"
release-gate run --repo "$PWD" \
  --receipt /tmp/codex-co-engineer-v3.4.3-release-gate.json
```

The package supports Node.js 24 and newer. The release gate is intentionally
pinned to Node.js 24, MCP Inspector 2.2.0, and the recorded ACPX/DSH
provenance so the release receipt is reproducible. The gate validates the
thin five-tool catalog (with durable wait/diagnostics/reply parameters on
`task`), package contents, provider-free Inspector smoke test,
ACPX reproducibility/provenance, and both package inventories. It does not
require provider credentials or send repository content to a model.

GitHub Actions mirrors the portable stages. It is diagnostic evidence, not a
replacement for the exact-tree local receipt.

## Host acceptance

After the provider-free gate passes:

1. Run `npm run setup:check` on the target host.
   This validates DSH/ACPX, the Cursor SDK, runtime versions, and bundled `worktree-bootstrap`
   dependencies. It does not install or authenticate Grok or Cursor Local,
   validate their CLIs or the Cursor Cloud key, or prove the local process
   boundary. Use the `status` tool to check provider readiness.
2. Validate Linux `systemd --user`, `systemd-run` 244 or newer, and unified
   cgroup v2 with the release/live process-boundary acceptance. The
   manager-owned transient systemd user service uses
   `KillMode=control-group` solely for descendant cleanup and to survive the
   launching client; it is not a sandbox or capability restriction.
3. Verify persistent normal authentication for Grok and Cursor Local, the
   OpenRouter key for Muse and Ox Alpha (with their separate model configuration),
   and the owner-only Cursor Cloud API key.
4. Run one bounded opt-in acceptance task through Grok, Cursor Local, Cursor
   Cloud, DSH Muse, and DSH Ox Alpha.
5. For local tasks, verify ACP first; if fallback occurs, prove it happened
   before prompt dispatch. DSH ACPX receipts may be `dispatch_uncertain` after
   spawn because ACPX has no authoritative prompt-sent acknowledgement; those
   tasks are never replayed. Verify terminal receipts, zero active tasks, clean
   direct-mode caller checkouts, and retained managed-worktree handoffs.
6. For Cursor Cloud, send the clean checkout's absolute path in the required
   property `repo` and use a provider-accessible origin. Also send an exact
   immutable commit SHA that is already pushed in the separate Cursor
   Cloud-only `starting_ref` property.
   An exact SHA reachable only from a feature branch can remain invisible to
   Cursor until an open PR or default-branch reachability makes it
   provider-visible. Create the draft PR before final Cloud acceptance (or
   make the commit reachable from the default branch). Surface a provider
   HTTP 400 for an otherwise-valid SHA as a visibility check/failure in the
   receipt, fix reachability, and only then retry. Verify the remote run,
   branch, and any PR are archived or accounted for.
7. Inspect the packed payload and current commit metadata for credentials,
   personal paths, and machine-specific information. Live receipts remain
   local and owner-only. They may contain bounded agent output/code context and
   must be treated as private state; verify that prompts and credentials are
   redacted.
8. Record the longest Codex Desktop MCP pending-call interval using
   [mcp-pending-call.md](mcp-pending-call.md). Do not treat the advertised
   4-hour `tool_timeout_sec` as a measured Desktop limit until those probes
   have been run on the shipping host.

## Local release installation identity

The public release candidate keeps the stable marketplace identity
`codex-co-engineer` in `.agents/plugins/marketplace.json`. Do not rename the
shipped marketplace to solve a local install collision, invent unsupported
install flags, or silently modify tracked manifests during installation.

Prefer a clean Codex installation for candidate qualification and onboarding.
When an existing installation already uses that marketplace identity, finish or
cancel active runs, then remove and re-add through the supported plugin CLI, or
keep the candidate in a separate clean Codex environment. Preserve any dirty
source checkout instead of changing its version label or replacing its files.

Codex can refresh installed local plugins when listing project marketplaces.
A project source with the same marketplace/plugin identity can replace the
shared cache even when its version is older than the configured global source.
An existing MCP process then retains paths into the removed version.

After installation, verify the actual project-scoped `plugin/list` operation for
open development checkouts: the candidate must remain installed and enabled,
its complete file inventory must match the qualified source, and stale
installations must remain uninstalled. Repeat the inventory check after the host
connection restarts, then run native provider acceptance. CLI marketplace
listing alone and a successful check immediately after copying files do not prove
persistence.

## Native run acceptance

Qualify the normal semantic `run_request` path as a complete user workflow.
A successful handshake, accepted consent form, or provider prompt dispatch is
an intermediate result. Acceptance requires the same run ID to deliver the
provider result, accurate terminal state, and retained handoff without asking
the operator to discover a hidden task ID or repair configuration.

Exercise the production task bridge with synthetic task-store fixtures in CI.
Only provider/process boundaries should be replaced for these contract tests;
replacing inspection, cancellation, and result projection would hide the very
interfaces being qualified. Cover completion, transient observation failure,
restart, cancellation, optional active assignments, unchanged cursors, and
bounded results. Verify that idle waits use event notifications and do not
continually rewrite run state.

After the exact-candidate gate, repeat one authorized host run through native
consent and normal run completion. A result recovered through a legacy task
fallback is useful diagnostic evidence, but it does not pass this acceptance.
Record the tested commit and whether other provider routes were exercised.
The lifecycle ownership decision is
[ADR 0002](adr/0002-native-run-lifecycle.md).

## Additional 3.4.3 candidate evidence

Keep every existing requirement above. The new result and comparison fixtures
are provider-free; they do not establish paid evaluation results or replace
live acceptance. The local gate and CI both run the comparison fixture suite
and the provider-free trial-usage and qualification unit stages.

For ownership changes, retain evidence of a completed producer, independent
review, specific feedback, a corrected candidate, and Codex's acceptance.
Exercise the successful revision, exhausted correction limit, stale head,
concurrent repeated request, missing lifecycle proof, and timeout after partial
output. Inspect revision lineage again after restart. Prove deadline extensions
against both the old and extended deadline with concurrent sessions.

The [development case study](demos/ownership-deadline.md) records real work;
it identifies the installed coordinator and the limit of each check. Before a
release showcase, capture actual use on the qualified host and label elapsed
time and any compression. Do not present a scripted walkthrough or fixture
comparison as live provider evidence. Fresh-user installation observations
should record the chosen provider, host class, tested version, first successful
outcome or failing step, and time to that result; keep private diagnostics local.

### Required 3.4.3 evaluation cohort

Before treating the candidate as evaluation-complete, run the matched
comparison under these rules. Missing evidence is inconclusive, not a pass.
Do not claim human-validation of agent onboarding.

1. **Budget.** Cap TOTAL API/Cloud spend at **$25** with an enforceable cap or a
   bounded maximum cost checked before dispatch. Refuse unpaid expansion once
   the cap is reached.
2. **Design.** Four approaches — native Codex, published 3.4.2, candidate
   3.4.3, and direct delegation — times **three** representative retrospective
   tasks times **two** repetitions = **24** trials. Use the seed43 case set and
   bind exact source identities.
3. **Accounting.** Record complete parent, helpers, reasoning, and compaction
   usage. Count every attempt, correction, and native helper. Cap owned
   corrections at **three** rounds. Enforce a **1-hour** total trial deadline.
4. **Gate thresholds (all required).**
   - Candidate: **6/6** accepted.
   - Median task-level native output per accepted result: **≤ 50%** of native
     and **≤ 75%** of published 3.4.2.
   - Astra's own output decreases relative to the native baseline.
   - Median wall clock: **≤ 2×** native.
   - Native overhead versus direct: **≤ 1.25×**.
5. **Onboarding.** Collect clean-environment agent onboarding evidence for the
   candidate install path. Do not claim that a human validated the agent
   onboarding path.

Follow the [benchmark protocol](../benchmarks/) for materialization and
analysis. Link [PR43](https://github.com/ajhcs/Codex-Co-Engineer/pull/43) for
the candidate path and for actual measurements when retained. Parent tip
`c50550e` is historical development evidence; an external execution manifest
binds the final integrated candidate SHA after integration. Synthetic fixtures
and this checklist do not establish savings. Missing usage stays unknown in the
[result report](run-results.md).

## Handoff and cleanup

Codex reviews and merges. Managed local worktrees remain until their result is
accepted or deliberately discarded:

```sh
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Use the exact lock ID reported by inspection; never delete a lock by hand.
Remove only the corresponding branch and terminal task-state directory after
the receipt is no longer needed. Direct-mode tasks have no managed worktree.
Cursor Cloud remote branches and PRs are provider artifacts and require
explicit review/closure.

Open the release PR only after the local gate, CI, package/privacy review, and
independent provider review pass. `create_pr` is Cloud-only; local workers
return commits and handoff evidence for Codex to decide whether a PR should be
opened. Never create an empty PR.

## Authorized GitHub publication

The release body is [releases/v3.4.3.md](releases/v3.4.3.md). Preserve all historical
release notes, including [3.4.2](releases/v3.4.2.md) and [3.4.0](releases/v3.4.0.md).
Documentation changes alone are not publication authorization; an explicit
maintainer release instruction is.

1. Fetch public main and reconcile it into the candidate. Both the published
   baseline and the accepted local fixes must be ancestors of the release.
2. Review the diff against public main, including deleted files, historical
   feature inventory, installation, packaged documentation, and privacy.
3. Run the exact-candidate local gate. Keep private host evidence outside Git.
4. Push the release branch without force and open a release PR. Verify current
   GitHub CI and required review before merging; do not bypass failed checks.
5. Merge the reviewed branch, capture the exact resulting main SHA, and verify
   that its tree matches the qualified candidate. If content changed, qualify
   the new candidate before tagging.
6. Create `v3.4.3` at that reviewed main SHA and publish the body from
   `docs/releases/v3.4.3.md`. Verify the remote tag, release body, source download,
   and tag-based installation instructions after publication.

The public release includes source and documentation. Never attach owner-only
live receipts, prompts, credentials, machine configuration, or private logs.

## Provider boundary regressions

Before live acceptance, exercise the installed ACPX CLI against local fake ACP
agents for success and model/API rejection. A nonzero exit must retain a useful
sanitized cause; raw outgoing requests and prompts must not enter public logs.
Test fragmented and oversized output, cancellation, deadlines, and cleanup.

Feed the Cursor adapter realistic SDK completion objects, including duration,
model, and usage metadata. Keep provider metadata separate from verified Git
and identity facts. A passing mock with a reduced response shape is insufficient.

Native consent checks cover timeout and same-run recovery. Host presentation
latency requires actual host observations; a protocol test does not establish
when the user saw the form.

## Orchestrator efficiency acceptance

Measure cold skill/schema loading separately from warm delegation. Compare the
same one-worker and four-worker tasks against native subagents with equivalent
prompts and required result detail. Count all orchestrator-visible requests,
responses, retries and recovery turns; exclude external worker tokens. Record
actual host usage where available and label tokenizer estimates otherwise.
Payload bytes alone do not establish token cost or native-subagent parity.

Exercise success, slow acknowledgement, one actionable question, cancellation
and failure. The normal path is one semantic submission and one aggregate wait;
routine progress must not require orchestrator polling. Inspect compact results
for retained errors, review artifacts and retrieval references for omitted detail.
Native comparison and live provider acceptance follow the exact-candidate gate
and a refreshed host connection; automated projection tests do not replace them.
