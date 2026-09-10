# Changelog

## [Unreleased]

Target: 3.4.3. Source candidate; existing release and host acceptance gates apply.

### Added

- Explicit provider preferences and bounded candidate revisions through the
  existing Co-Engineer tool surface, preserving external ownership and prior
  evidence instead of rebuilding correction assignments in the lead agent.

- Ordinary run results and on-demand usage evidence through the existing ledger
  and decision-card helpers; unknown usage stays unknown and completion never
  implies Codex acceptance.
- A one-provider first-outcome example, issue forms, PR template, support links,
  contributor tasks, roadmap, and a documented real development correction loop.
- Reproducible frozen comparison cases and an offline analyzer covering native
  helpers, corrections, failed attempts, exact source identities, and missing
  acceptance coverage. Synthetic fixtures do not establish savings.
- OpenAI showcase preparation with the current local-MCP submission limitation.

### Changed

- Delegate complete engineering assignments, checks and corrections to external
  owners; return compact evidence for Astra and other autonomous lead agents.
  Preserve final review, host model defaults, and repository authorization.

- Cap owned correction chains at three rounds, reserve one admitted child per
  producer across server processes, and retain lineage through restart.

### Fixed

- Make supported deadline extensions govern the active ACP turn and preserve
  timeout/cancellation truth after partial provider output.
- Preserve empty capability restrictions and complete Unicode review feedback;
  reject unproven producers and competing feedback instead of silently dropping it.
- Direct terminal uncertainty to inspection and keep active work on bounded waits.

## [3.4.2] - 2026-09-08

### Fixed

- Instruct providers to honor the requested answer format and omit routine
  narration and unrequested evidence headings. Controller evidence requirements
  remain intact and do not act as an answer template.
- Return Grok's final response after a settled tool round on successful tasks.
  Preserve progress in task events and retain aggregate output when framing is
  ambiguous, incomplete, over limit, or includes inline web search.
- Handle processes disappearing during verification cleanup scans and parse
  parenthesized process names correctly, while preserving fail-closed errors.
- Remember explicit native approval for the same repository and selected
  providers, with a one-run option and local revocation. Remove the redundant
  approval checkbox and allow more time to answer the native form.
- Detect missing installed worker entrypoints before preparing workspaces or
  dispatching providers, with actionable reinstall and restart guidance.
- Direct provider workers to their assigned working directory and clarify
  controller-owned receipts, reducing unnecessary setup and evidence searches.

- Adapt Cursor Cloud SDK results before internal validation so documented
  timing, model, and usage metadata does not prevent terminal result delivery.
- Use ACPX's one-shot command for DSH, preserving bounded provider errors and
  results without a nested flow or replaying a submitted prompt.

- Deliver the compiled assignment instructions and pin local workspaces to
  the recorded commit; reject unsupported provider model overrides instead
  of silently launching another model.

- Align semantic runs with the authoritative provider task lifecycle, including
  result delivery, recoverable observation failures, cancellation, and restart.
  Reuse event-driven task waits and keep unchanged run receipts stable.

- Wire semantic launch consent to native MCP forms, with explicit unsupported
  host handling and same-run consent retry. Preserve pending/terminal receipts
  and cursors; distinguish planned review work from completed evidence.

- Reject future-dated repository-exposure approvals and make consent-window
  fixtures independent of today's date. Remove ambient Git/network and
  fixed-sleep dependencies from affected regression tests.

- Semantic `run_request` launches now satisfy the advertised MCP JSON Schema
  without legacy single-task fields; ambiguous dual envelopes are rejected.
- Valid disjoint writer globs use the authoritative overlap validator instead
  of a duplicate check that rejected separate directories.
- Repeated status checks no longer repeat terminal cleanup grace periods for
  previously reconciled receipts; ownership inspection remains active.
- Preserve structured Cursor permission options through grouped questions and
  stop treating shell command punctuation as user input.
- Distinguish explicit Grok login status from ancillary command errors during
  readiness checks.
- All-Cursor Cloud runs skip the irrelevant local systemd/cgroup prerequisite;
  mixed and local runs still enforce it.
- Assignment access can be derived from its explicit role, eliminating a
  redundant launch field while rejecting explicit role/access conflicts.

### Changed

- Bundle MIT-licensed Worktree Bootstrap 1.1.0 with recorded source provenance.
  Local setup no longer depends on a separately installed private tool; Python
  3.11+ is required. Validate runtime prerequisites before installation.
- Reorganize installation and first-use documentation, include detailed upgrade
  notes, and keep Luna/Sol coordination explicitly optional.

- Default Muse to `meta/muse-spark-1.3-contributor` through OpenRouter with
  XHigh reasoning, using only the OpenRouter credential for that route.
- Release checks honor the operator's configured npm cache and temporary
  storage instead of forcing a machine-specific cache path.

- Added evidence-qualified Luna / Terra / Sol / Astra task-selection guidance.
  Prefer one owner with bounded workers; an extra coordinator and reasoning
  effort changes require task-specific justification. Model choice stays host-owned.
- Made the installed skill path use existing provider choices and semantic
  admission directly, with setup and manager tasks outside routine launch.
  Clarified continuation, typed approvals, dependent reviews, and verification.
  Provider prompts stay focused on requested output, tests and brief evidence;
  the controller creates managed worktrees while the worker wrapper owns
  verification, hidden writer tokens, lifecycle and machine receipts.

## [3.4.1] - 2026-09-01

Reliability candidate for bounded Co-Engineer implementation lanes. Preserves
the five public tools and 3.4.0 compatibility while adding a server-compiled
`run_request`, atomic pre-prompt admission, truthful dispatch evidence,
restart-safe session recovery, typed repository-exposure consent,
capability-aware attention batching, idempotent cancellation, silence-aware
handoffs, readiness caching, and bounded simple-run responses. See
[`docs/releases/v3.4.1.md`](docs/releases/v3.4.1.md) and the exact baseline
ledger in [`docs/releases/v3.4.1-baseline.md`](docs/releases/v3.4.1-baseline.md).

The candidate still requires host consent integration, an official exact-SHA
local-only `worktree-bootstrap` capability, the Codex Desktop history-bound
regression, and live provider acceptance before release publication.

## [3.4.0] - 2026-08-28

3.4.0 is the Co-Engineer experience and efficiency release. It keeps the
five-tool MCP catalog and 3.2.1 compatibility path while making bounded runs
easier to start, cheaper to supervise, more truthful under interruption, and
safer to publish.

### Added

- **Luna-first interrupt orchestration.** Luna Max can remain the low-cost
  relay/control layer for typed task-to-task messages and wake Sol only for
  meaningful events or decisions. Attempt and generation fences reject stale
  deliveries; thread messages remain coordination evidence rather than
  implicit merge authority.
- **Deterministic event reduction and lane health.** Routine progress is
  reduced without another model pass. Completed, blocked, failed, question,
  timeout, user-update, and merge-ready boundaries produce compact,
  replayable acknowledgement evidence and progressive lane status.
- **Truthful usage accounting.** Immutable `UsageLedgerV1` receipts separate
  provider-reported tokens, host-visible model bytes, retrievable evidence,
  submissions, invocations, waits, attention rounds, retries, elapsed time,
  and explicitly unknown measurements. Eight-lane ledgers have fixed
  non-caller-selectable complexity and byte bounds.
- **Proof-bound cleanup planning.** Cleanup revalidates task, worktree, lock,
  ref, and expected SHA immediately before action and reports machine-readable
  blockers instead of inferring ownership from age.

- **PR-ready final decision card.** Adds additive v3
  `final-decision-card.mjs`: a side-effect-free projection of typed
  candidate identity, worktree cleanliness, verifier/test/CI evidence and
  freshness, non-force push state, draft PR identity, and
  provider/assignment attribution. `ready_for_sol_merge` is computed only
  from those facts, never from provider prose, hidden or unknown checks,
  stale evidence, missing topology, missing verifier acceptance, a dirty
  worktree, an unpublished head, a mismatched PR head, protected-ref
  mutation, or unresolved lanes. Otherwise the card emits a complete
  bounded list of exact blockers. Progressive disclosure keeps a compact
  model-facing summary plus artifact references, with deterministic
  truncation provenance. The public label is `PR-ready` or `Blocked`.
  The card cannot merge; Sol High/XHigh alone may regular-merge after
  exact-head, tree, current-green-CI, and topology CAS checks. Coverage
  lives in `test/r1-final-decision-card.test.mjs` and
  `test/r1-final-decision-card-adversarial.test.mjs`; the boundary lives
  in `docs/final-decision-card.md`.

### Fixed

- **PR-ready card identity, lanes, draft PR, and git operation.**
  `exact_head`/`exact_tree` now bind independently observed identities
  carried by verifier, test/CI, push, and PR receipts; format-only SHAs
  and stale booleans never authorize a substituted head or tree. Required
  lanes qualify only when explicitly accepted; cancelled, failed,
  blocked, `needs_attention`, unresolved, `transport_lost`,
  `environment_blocked`, unknown, or nonterminal required lanes block
  readiness. Draft PR evidence must prove repository, host/provider,
  target branch, exact head, open+draft state; a number-only or arbitrary
  HTTPS URL is not trusted. A typed `active_git_operation` other than
  `none` blocks readiness even when porcelain is clean.
- **PR-ready card artifact attribution integrity.** Lane-scoped artifact
  references bind to an `assignment_id` present in the parsed
  attribution set for the exact run. A ghost or unknown assignment is a
  deterministic blocker, is never projected as trusted, and never yields
  `ready_for_sol_merge`. The card does not infer a run-level external
  artifact class; ArtifactRefV1 remains lane-scoped.

## [3.3.0] - 2026-08-27

R1 bounded-run release on the same five-tool MCP catalog. One run is 1–8
independent assignments against one immutable repository/base identity, with
data-only profiles, trusted verification policy, additive run parameters, and
exact 3.2.1 single-task compatibility when those parameters are omitted.

### Fixed

- **P11 identity namespace, non-success, overflow, and content-free failure.**
  Provider-report ArtifactRef paths now bind `provider`, `model`, and
  optional child-envelope digest into a P07-strict namespace so two
  identities cannot share a path or ref. Failed/cancelled ACP turns never
  publish accumulated partial text as complete. Collector overflow at the
  raw class cap is handled inside `attachLocalProviderResultSink` with
  typed content-free evidence and does not rewrite the provider terminal
  or claim complete output. `contentFreeSinkFailureV1` allowlists closed
  code/path values and uses one generic bounded message.

### Added

- **Live protected-ref audit.** Adds additive v3 `protected-ref-audit.mjs`
  (P30): a read-only live comparison of declared protected and default refs
  against immutable expected identities. Local, bare, and linked-worktree
  repositories are observed argv-only under the accepted P29 inspect
  environment. Missing, moved, aliased, symbolic, packed, hostile, and raced
  refs produce deterministic content-free evidence; packed storage that still
  matches its expected SHA verifies. The audit consumes accepted P28
  classification and P29 remote-mutation denial without wrapping or weakening
  them, never materializes credentials, and never mutates refs, worktrees,
  indexes, config, or remotes. Receipts project P13
  `protected_ref_snapshot_compare` facts plus an all-false side-effect
  nonclaim map. No API, run orchestration, release, or Gate A scope.
  Coverage lives in `test/r1-protected-ref-audit.test.mjs` and
  `test/r1-protected-ref-audit-adversarial.test.mjs`; boundaries live in
  `docs/protected-ref-audit.md`.
- **Run dispatch orchestration boundary.** Adds additive v3
  `run-orchestration.mjs` (P31): it binds accepted P26 preflight to
  accepted P29 closed credential/environment projection before any
  workspace, branch or ref, reservation, dispatch, credential handoff, or
  provider process exists. Preflight failure and host CPU/RAM capacity
  denial fail closed with zero side effects. Prepare projects isolated
  per-lane environments and still creates no handoff and no process.
  Explicit dispatch uses an injected seam with closed env, credential-free
  argv, owner-only identity-bound handoff files, cleanup on
  failure/cancel/terminal/restart, content-free errors, and denied worker
  remote mutation. The boundary never provisions workspaces, never audits
  live refs (P30), never exposes a public API, and does not claim Gate A
  or supervisor/server cutover. Coverage lives in
  `test/r1-run-orchestration.test.mjs` and
  `test/r1-run-orchestration-adversarial.test.mjs`; the boundary lives in
  `docs/run-orchestration.md`.
- **Provider registry composition authority.** Adds the additive v3
  `provider-registry.mjs` module (P23): the deterministic, closed
  composition authority behind provider selection. It registers exactly the
  four accepted `ProviderDriverV1` adapters (P18 Grok ACP `grok`, P19
  Cursor Local `cursor-local`, P21 Cursor Cloud `cursor-cloud`, P20 DSH
  ACPX `dsh`) in the frozen P02 grammar slot order, re-deriving that
  vocabulary from the accepted grammar leaf so it cannot drift. Selection
  (`resolveRegistrySelectionV1`) maps an exact `{provider, model}` pair
  onto one entry under `exact_closed_slot_no_fallback` with no preference
  walk, substitution, fallback, retry, or replay; closed model lists are
  enforced against accepted constants and grammar-owned models stay with
  their adapters, so no vocabulary is widened. Composition
  (`composeProviderDriverV1`) gates the provider before reading any option
  byte, quarantines hostile inputs content-free (Proxies, accessors,
  symbols, non-enumerables, exotic prototypes, unknown keys fail closed
  without running caller code), delegates to the one exact accepted factory,
  and returns its value untouched so adapter lane stores, evidence maps,
  and identity binding keep accepted semantics. Inventory
  (`describeProviderRegistryV1`) quotes each accepted module's own describe
  surface in detached frozen clones instead of restating capability claims.
  The P22 future-harness template/conformance kit is inventoried as
  mock/conformance evidence only: never a fifth provider slot, never
  selectable, never composable here. The registry performs no ambient
  discovery (no filesystem, environment, PATH, network, clock, random
  source, process, or dynamic import), performs no supervisor/server/
  scheduler/durable-store cutover, claims no live transport qualification,
  merge/PR authority, or direct mode, and changes no version or 3.2.1
  legacy behavior. Coverage lives in `test/r1-provider-registry.test.mjs`,
  `test/r1-provider-registry-adversarial.test.mjs`, and
  `test/r1-provider-registry-integration.test.mjs`; boundaries live in
  `docs/provider-registry.md`.

- **Git authority policy.** Adds additive v3 `git-authority.mjs` (P28): a
  closed immutable `GitAuthorityPolicyV1` for protected/default refs, the
  `codex/run-<digest-prefix>/<assignment>` lane namespace, credential-free
  repository/ref identity, and operation authority. External agents and
  providers cannot merge, rebase, push, create PRs, mutate
  protected/default refs, create tags/releases, or obtain
  credential/remote mutation authority. Default-branch targets, merge
  histories, namespace/confusable/ref-grammar attacks, unknown
  operations/keys, proxy/accessor inputs, and bounds abuse fail closed.
  Verdicts and P13-compatible facts/discrepancies are content-free and
  never echo repository paths, URLs, credentials, provider text, or
  hostile refs. This is policy at the authority seam only: no Git
  mutation, no P29 credential isolation, and no P30 protected-ref audit.
  Coverage lives in `test/r1-git-authority.test.mjs` and
  `test/r1-git-authority-adversarial.test.mjs`.
- **Cursor Cloud result source.** Adds additive v3
  `cursor-cloud-result-source.mjs` (P12) that materializes Cursor Cloud
  provider-reported result/output/status and independently observed
  Git/branch/commit/PR evidence as distinct typed sources through the
  accepted P09 sanitizer, P08 store, and P10 sanitized reader. Trusted Git
  facts are never synthesized from provider text. Receipts expose only
  bounded sanitized tails, refs, digests, and provenance; upstream
  `source_truncated` is recorded separately from local inline clipping and
  fail-closed storage limits. Exact run, assignment, request, repository,
  branch, and head/base identity is bound into ArtifactRef paths; mismatch
  fails closed with no replay. The Cursor Cloud worker is the only
  serialized seam and preserves 3.2.1 `task.result` / `result_*` public
  bytes when exact R1 identity is absent. Coverage lives in
  `test/r1-cursor-cloud-result-source.test.mjs` and
  `test/r1-cursor-cloud-result-source-adversarial.test.mjs`.
- **Local provider result sink.** Adds additive v3
  `local-provider-result-sink.mjs` (P11) that routes final local Grok ACP,
  Cursor Local ACP, and DSH ACPX/CLI provider output into the accepted
  P08/P09 raw+sanitized artifact store through one provider-neutral sink,
  binding exact `run_id` / `assignment_id` / `provider` / `model` / optional
  child-envelope digest identity into the ArtifactRefV1 path. The complete
  transport-available result is stored up to the existing class cap; older
  output is never silently discarded, empty results stay unpublished, and a
  source that the upstream already clipped is persisted with truthful
  `source_truncated` / `complete` provenance. Only sanitized artifacts are
  model-readable. The receipt is detached deep-frozen content-free
  metadata (raw/sanitized refs, P09 provenance, digests, counts,
  truncation) plus a default inline tail of at most 4,096 UTF-8 bytes
  derived through the accepted P10 sanitized reader and aligned on a valid
  UTF-8 boundary, with inline clipping recorded separately from upstream
  truncation. The ACP worker is the only serialized seam: it preserves
  3.2.1 `task.result` / `result_*` and event/terminal shapes, attaches
  optional `provider_result_sink` metadata only after provider terminal
  publication, and records typed content-free evidence on sink failure
  without inventing completion or replaying provider work. Coverage lives
  in `test/r1-local-provider-result-sink.test.mjs` and
  `test/r1-local-provider-result-sink-adversarial.test.mjs`.
- **Atomic raw/sanitized artifact store.** Adds the additive v3
  `artifact-store.mjs` module for W4-P08: it binds validated ArtifactRefV1
  declarations to real bytes under one caller-supplied existing private store
  root, mapping each strict relative path segment-for-segment into disjoint
  `raw/` and `sanitized/` namespaces (`content/<path>` plus a strictly parsed
  canonical sidecar per artifact), so raw evidence and model-facing
  projections never collide even at one path and no parallel ref or path
  schema is introduced - references are parsed with `parseArtifactRefV1` and
  nothing else, so traversal, absolute paths, reserved device names,
  separator look-alikes, and Unicode tricks inherit the exact P07 denials.
  Sources are intrinsic Buffer/Uint8Array views or bounded async iterables of
  such views; proxies, subclasses, SharedArrayBuffer backings, strings,
  accessor-shaped iterables, and arbitrary class instances are denied before
  any byte is read. Declared byte length and SHA-256 are treated as untrusted
  claims: bytes stream into an unpredictable owner-only same-directory
  temporary while the class cap (sanitized 256 KiB, raw 32 MiB) is enforced
  on every chunk before it is written, actual length and digest are computed
  from the streamed bytes, and both must match the declaration exactly before
  publication; the temporary is fsynced, published by exclusive hardlink that
  refuses to clobber, unlinked, and the parent directories fsynced, so no
  partial artifact ever exists under an authoritative name. Exact same
  validated ref plus bytes is idempotent across concurrent submissions (one
  deterministic winner plus idempotent losers behind a per-root operation
  chain); conflicting content at one location, the same digest under
  different metadata, or any other competing publication fails closed with
  typed content-free errors and leaves the authoritative state untouched,
  rolling back a race loser's own link only when the platform proves the
  inode is ours. Roots and parents use descriptor/no-follow discipline -
  O_NOFOLLOW|O_DIRECTORY opens, device/inode identity brackets, lstat-walked
  0700 parent chains re-proven after publication - rejecting missing,
  non-private, symlinked, replaced, and swapped roots and parents wherever
  provable. Verification and audit stream stored bytes in fixed chunks solely
  to recompute length and digest (never returning or buffering content),
  enumerate with bounded per-directory entries, files, depth, and total
  audited bytes, and condemn leftover or torn temporaries (a reserved name
  grammar artifacts may never spell), orphaned or duplicate sidecars,
  symlinks, hardlinks, FIFOs and other non-regular entries, foreign names,
  truncated or oversized content, malformed or misplaced metadata, and
  content swapped under a path; audits return detached frozen metadata plus a
  framed inventory fingerprint that restarts reproduce exactly. Receipts,
  verdicts, and reports are deep-frozen, content-free, and never echo the
  store root, artifact bytes, or operating-system errors. Out of scope and
  unclaimed: P09 sanitization, the P10 reader, the P13 evidence bundle,
  cleanup, scheduler/provider/supervisor wiring, and protected references;
  a torn store stays torn and fails closed until an operator acts. Coverage
  lives in `test/r1-artifact-store.test.mjs` and
  `test/r1-artifact-store-adversarial.test.mjs`.
- **ScopeVerifierV1 independent changed-path ownership, read-only, and
  merge-commit verifier.** Adds an additive v3 `scope-verifier.mjs` module
  for W16-P15. It consumes only trusted P14 `GitIdentityV1` snapshots and
  P13 `VerifiedFactV1` / `EvidenceDiscrepancyV1` records, never provider
  claims, and binds content-free `git_diff` / `head_sha` facts
  (`platform_git` with `scope_match`, `read_only_no_changes`, and
  `merge_commit_absence`). Observation is argv-only (`/usr/bin/git`, no
  shell) through the P14 closed environment with system/global/caller
  config and protocols disabled; output, time, and command counts are
  bounded; typed errors never echo hostile bytes. It validates ownership
  of additions, deletions, renames, and copies against trusted assignment
  write-scope globs (P02 matcher), including overlap with other writers,
  symlink/gitlink/type-change, Unicode NFC vs confusable separators, and
  tracked plus untracked state. Read-only lanes must have no candidate or
  worktree mutations. Merge commits and multi-parent histories fail.
  Pre/post identity and worktree fingerprints detect observation races
  and fail closed. It does not own P16A trusted command policy, P28 Git
  mutation, P30/P35 composition, server/supervisor integration, network,
  or merge/rebase/push/PR. Coverage lives in `r1-scope-verifier` and
  `r1-scope-verifier-adversarial` tests plus disposable rename, merge,
  symlink, gitlink, Unicode, untracked, and race fixtures.
- **GitIdentityV1 independent repository, ancestry, and merge-base
  verifier.** Adds an additive v3 `git-identity.mjs` module for W13-P14.
  It derives Git facts from the local repository through argv execution
  (`/usr/bin/git`, no shell) and never from provider claims, then binds
  repository identity, expected base ref/name, exact base SHA, candidate
  head SHA, object types, reachability, ancestry, merge-base identity,
  and rewritten/stale history into P13 `VerifiedFactV1` /
  `EvidenceDiscrepancyV1` snapshots (`git_identity` and `head_sha` with
  `platform_git` / `ancestry_check`). Observation uses a closed
  environment that cannot inherit `GIT_*`, replace, graft, or config
  influence; output, time, and command counts are bounded; typed errors
  never echo hostile bytes. It rejects missing/wrong repos, symbolic-ref
  drift, detached/unborn/ambiguous refs, non-commit objects, replace
  refs, grafts, hostile names, extra keys, proxies/accessors, and bounds
  abuse. It does not own P15 scope/read-only/merge-commit checks, P16A
  trusted command policy, P28 Git mutation, or provider/workspace
  dispatch. Coverage lives in `r1-git-identity` and
  `r1-git-identity-adversarial` tests plus disposable forged/stale/
  rewritten fixtures.
- **Constrained verification runner.** Adds additive
  `constrained-verification-runner.mjs` for W16-P16C. The module consumes a
  genuine immutable P16B ExecutionIntent receipt plus trusted P16A
  `VerificationPolicyV1`, creates a disposable verification workspace
  disjoint from the candidate, and executes the exact owner-approved
  absolute executable and argv once with `shell=false` and no PATH lookup.
  The child environment is empty by default and receives only
  policy-authorized bounded entries. The runner enforces timeout,
  signal/termination fail-closed rules, stdout/stderr byte caps,
  host-available process isolation (Linux user/pid/net namespace via
  `unshare` on the default adapter), network deny/default (allowlists are
  unsupported), and one execution only. Candidate Git identity and
  filesystem are audited before and after; persistent
  candidate/ref/config/worktree mutation fails closed. Temporary cleanup
  deletes only the exact workspace this invocation created. Outcome
  evidence is bounded, sanitized, and P13-compatible: host-observed exit
  status is never upgraded from provider-reported PASS. The module is not
  wired into the MCP server, supervisor, scheduler, or process-boundary
  worker launcher, and it does not merge, rebase, push, open a pull
  request, or mutate a protected ref. Coverage lives in
  `test/r1-constrained-verification-runner.test.mjs` and
  `test/r1-constrained-verification-runner-adversarial.test.mjs`.
- **Approved verification-command resolver.** Adds additive
  `approved-verification-command.mjs` for W15-P16B. The module consumes an
  immutable trusted `VerificationPolicyV1` from P16A plus a closed
  Codex/owner selection of `command_id` and typed parameter values, and
  returns a fresh frozen ExecutionIntent / ApprovedCommand receipt. Every
  parameter is checked against the owner-authored domain (exact name set,
  required semantics, types, enums, ranges, length, and path-segment
  grammar). Expansion substitutes only whole-token `{name}` placeholders
  from the owner argv template; there is no shell string, PATH lookup,
  executable override, interpolation, substitution, globbing, or option
  smuggling. Provider, profile, and manifest reported commands remain
  evidence only: matching command-id or argv text does not authorize
  resolution. Receipts bind policy identity, command-descriptor identity,
  canonical parameters, executable path, exact argv, and inherited P16A
  constraints without executing. Hostile containers fail closed with typed
  content-free errors. Callers' objects are neither mutated nor frozen.
  The module never invokes a shell, resolves PATH, opens a network socket,
  reads arbitrary workspace files, mutates a candidate, or implements the
  later P16C runner. Coverage lives in
  `test/r1-approved-verification-command.test.mjs` and
  `test/r1-approved-verification-command-adversarial.test.mjs`.
- **Trusted VerificationPolicyV1 schema and owner-authored policy loader.**
  Adds additive `trusted-verification-policy.mjs` for W14-P16A. The module
  owns a versioned immutable command catalog: each stable command ID binds
  an owner-authored absolute executable path, a fixed argv template, typed
  parameter domains, and explicit network, environment, mutation, timeout,
  and output policies. Absent capabilities materialize as exact default-deny
  receipts (no network, empty environment, no persistent mutation, bounded
  time and output). Canonical identity/digest is framed through the P03
  `verification-policy.v1` / `verification-command-descriptor.v1` labels.
  Profiles, manifests, and provider reports may name a command ID and typed
  parameters only; executable paths, argv, shell text, environment, network
  targets, mutation grants, and resource limits are rejected on that
  untrusted surface. Hostile containers fail closed (proxies, accessors,
  symbols, exotic prototypes, cycles, bounds, ambiguous IDs) with typed
  content-free errors. The owner loader reads
  `<config>/codex-co-engineer/verification-policy.json` and never invokes a
  shell, resolves PATH, executes a command, opens a network socket, mutates
  a candidate, or implements the later approved-command resolver/runner.
  Coverage lives in `test/r1-trusted-verification-policy.test.mjs` and
  `test/r1-trusted-verification-policy-adversarial.test.mjs`.
- **ArtifactRefV1 and the strict relative artifact path policy.** Adds two
  additive, pure v3 modules for W3-P07. `artifact-path.mjs` owns one
  deterministic fail-closed question - is this string a strict portable
  run-relative artifact path? - accepting only NFC, well-formed,
  forward-slash, relative paths of 1..16 segments (128 UTF-8 bytes each,
  1024 total) with no backslashes, leading/trailing/doubled slashes, empty
  or dot-only segments, colons (foreclosing drive, UNC, alternate-data-
  stream, and scheme spellings in one rule), Windows reserved device stems
  (`con`, `CON.txt`, `com1`, `lpt0`, `clock$`), edge dots/spaces Windows
  strips, C0/C1 controls, invisible/format/bidi/tag code points, or solidus
  look-alikes; the fixed validation pipeline raises identical first typed
  errors from a closed 17-code vocabulary and never echoes hostile bytes.
  `artifact-ref.mjs` binds the closed ten-key ArtifactRefV1 schema - exact
  run/child identifiers reusing the accepted manifest grammars, artifact
  kind bound to the P17 capability vocabulary, raw-vs-sanitized class with
  class-dependent bounded-evidence caps (sanitized 256 KiB, raw 32 MiB),
  declared byte length, lowercase-hex SHA-256, and closed media-type and
  content-encoding enums - behind hostile-container hardening that rejects
  live/revoked Proxies with zero traps, accessors without invoking them,
  symbol keys, exotic prototypes, own undefined, sparse/extended arrays,
  aliases/cycles, depth, and size before any effect, returns deep-frozen
  detached snapshots, and frames SHA-256 digests over validator-owned
  canonical JSON with explicit domain/version/label separation so key order
  cannot change a digest while any value change must; ordering is a fixed
  tuple comparator plus a bounded (64), duplicate-free batch orderer. Both
  modules are pure schema/path policy only - no filesystem, network, or
  process I/O - and neither claims that P08 artifact storage exists:
  producers declare references, and only a later storage authority may bind
  them to bytes. Coverage lives in `test/r1-artifact-ref.test.mjs` and
  `test/r1-artifact-ref-adversarial.test.mjs`.
- **Grok ACP ProviderDriverV1 adapter (P18).** Additive `grok-acp-driver`
  binds provider slot `grok` onto the accepted P17 preflight/launch/
  reconcile/cancel contract and the P05 13-field capability record
  (`confirmed_launch`, `live_session_reply`, local managed worktree at
  `run_base_sha`, `never_replay`, no merge/PR authority). An injected
  bounded ACP transport keeps tests deterministic: launch is `dispatched`
  only after an authoritative acknowledgement; any exception, timeout,
  loss, or unusable receipt after spawn/dispatch intent is returned as
  `dispatch_uncertain` and is never retried, replayed, or
  fallback-substituted. Duplicate launch, digest-only launch, direct
  mode, merge/PR, and cross-provider/model drift fail closed. Bounded
  live progress, detailed events, same-session reply identity,
  cancellation confirmation, and restart reattach are supported exactly
  where Grok ACP supports them, with stale session/run/child/model/
  workspace identities failing closed. Event pages, text, counts,
  cursors, timings, and diagnostics are capped; envelope/prompt bytes
  stay evidence and do not enter driver results or transport
  preflight/observe/cancel/reattach requests. Process-local P17 lane
  risk may remain; the module does not claim durable P19/P21 state,
  supervisor cutover, or live Grok ACP qualification. Coverage lives in
  `r1-grok-acp-driver` and `r1-grok-acp-driver-adversarial` tests.
- **Closed P20 DSH ACPX provider driver for Muse Spark 1.2 Contributor and Ox
  Alpha.** Additive `DshApxDriverV1` hard-binds provider `dsh` plus exactly the
  two allowed DSH models and implements the accepted P17 preflight/launch/
  reconcile/cancel lifecycle against an injected bounded ACPX one-shot
  transport port, inheriting every envelope, capability, transition, and denial
  rule from the accepted contract with no parallel schema. ACPX provides no
  authoritative prompt-sent acknowledgement: after spawn intent the posture
  stays `dispatch_uncertain`, post-intent exceptions and loss are never
  replayed, retried, or fallback-substituted, and only provably pre-spawn
  failures may report `not_sent` under a two-attempt lane budget. Same-session
  reply is unsupported: unresolved attention surfaces honestly and no
  replacement prompt or session is started. Live progress, detailed events,
  cancellation confirmation, and restart recovery read recorded ACPX evidence
  through bounded cursor-monotonic pages; exact model/config/credential
  identity and task/session correlation fail closed on drift; forged receipts
  fail closed while genuine loss degrades to uncertainty. Events, records,
  cursors, lanes, attempts, operations, clock readings, and diagnostics are
  capped, and detail telemetry is content-free by construction. The module
  claims no real-transport qualification, durable P19/P21 store, supervisor
  cutover, or merge/PR authority; the exact port surface for later real DSH
  Muse/Ox lifecycle conformance is recorded in
  `docs/dsh-acpx-driver.md`. Coverage lives in `r1-dsh-acpx-driver` and
  `r1-dsh-acpx-driver-adversarial` tests.
- **Closed P17 provider-driver envelope and capability contract.** Additive
  `ProviderDriverV1` owns the preflight/launch/reconcile/cancel lifecycle
  plus typed results, exact ChildEnvelopeV1 launch proof (text bytes and
  raw lowercase 64-hex P03 digest; digest-only launches are denied), and
  honest capability declaration through the accepted P05 13-field
  `ProviderCapabilitiesV1` bridge rather than a parallel schema.
  Driver-surface features for same-session-adjacent live progress,
  reconcile-only restart reattach, cancellation, and detailed events fail
  closed when unsupported, with no fallback or post-dispatch replay.
  Process-local status transitions refuse duplicate dispatch, stale
  envelope correlation, and capability-contradicting launch certainty.
  Direct-JS inputs use the P05 descriptor-first closure; validated values
  are detached and deeply frozen. The module claims no provider transport,
  registry cutover, scheduler, or durable store. Coverage lives in
  `r1-provider-driver` and `r1-provider-driver-adversarial` tests plus the
  reusable `provider-driver-contract-suite` harness.

- **Aggregate journal binding after R24A resolution_ready (R25B).** Additive
  `run-journal.mjs` gains stamp v2 and distinct
  `createAggregateRunJournal` / `openAggregateRunJournal` entrypoints that
  bind an existing P25 journal root/run identity to an exact validated R24A
  marker, claim, anchor, coordination, and resolved-plan identity only after
  that aggregate run is `resolution_ready` and the durable resolved-plan
  record/digest re-verify. Legacy `createRunJournal` / `openRunJournal`,
  stamp v1, fingerprint, six event kinds, reducer/state/cursor schemas, and
  lock order stay byte- and behavior-identical; standalone P24/P25 callers
  are unchanged. There is no migration, cross-open, root adoption,
  empty-root inference, or legacy-to-aggregate fallback. Missing,
  malformed, mismatched, or swapped R24A records, marker/claim/stamp
  substitutions, symlink/hardlink/non-regular files, wrong run/root/plan,
  stale phase/revision, and post-validation TOCTOU fail closed with typed
  content-free errors. Identical aggregate identity reopens and replays
  exactly; a different binding is a permanent conflict. Coverage lives in
  `r1-run-journal-aggregate` and `r1-run-journal-aggregate-adversarial`
  tests. R24A record publication remains in `aggregate-run-anchor.mjs`.
- **Aggregate pre-dispatch run anchor for unresolved P05 selection.** Additive
  `aggregate-run-anchor.mjs` persists one immutable AggregateRunAnchorV1 plus
  absorbing coordination state for runs whose P05 provider/model selection is
  still unresolved, inside a caller-supplied existing private root distinct
  from accepted P24/P25. The P03 registry gains closed labels `storage-root.v1`,
  `aggregate-run-anchor.v1`, `aggregate-run-coordination.v1`,
  `aggregate-submission-idempotency.v1`, `aggregate-run-claim.v1`,
  `aggregate-selection-reply.v1`, and `aggregate-resolved-plan.v1`.
  `initializeAggregateRunAnchorRoot` publishes an atomic owner-only
  `storage-root.v1` marker of kind `aggregate_run_anchor` plus a nonce, and
  only onto an existing private completely empty root. Open rejects unmarked
  empty roots and nonempty P24, P25, or foreign layouts, and every operation
  reverifies root and marker identity. `claims/<run_id>.json` is durable
  before `runs/<run_id>`: a claim binds run, anchor, submission key, marker,
  and claim nonce/digest. Namespace lock then per-run lock. An empty directory
  without the exact claim is never adopted; the exact claim recovers the same
  identity; a mismatch conflicts; losers never remove winner paths. High-level
  `commitSelectionRequest`, `commitSelectionResolution`, and
  `commitResolvedPlan` publish bounded canonical JSON records at fixed names,
  fsync, and verify the full record before coordination references it. Exact
  orphan records are adopted; differing orphans conflict; committed missing,
  malformed, or digest-mismatched files are corruption. The lattice is
  `submitted@0` → `awaiting_selection@1` → `resolution_ready@2`, or
  `submitted@0` → `resolution_ready@1`; revisions are exact, the terminal
  phase is absorbing, and identical retries are idempotent. There is no public
  digest CAS, journal, reducer, scheduler, provider, workspace, server, or MCP
  wiring, and no migration of P24/P25. Coverage lives in
  `r1-aggregate-run-anchor` and `r1-aggregate-run-anchor-adversarial` tests.
- **Append-only run journal, deterministic reducer, and run-bound cursor.**
  Additive `run-reducer.mjs` / `run-journal.mjs` persist one bounded
  append-only canonical JSONL event chain per run inside a private per-run
  directory of a separate caller-supplied existing private journal root.
  Every create/open/append/read first binds an exact validated accepted-P24
  durable run record (the `openRunStore(...)` handle and its `getByRunId`
  result) by run identity and canonical digest, never writes into the P24
  root (sharing it fails closed), and re-verifies a creation stamp bound to
  that record on every operation, so inode-reuse directory swaps fail hard.
  Entries carry dense sequences over closed event and content-addressed
  artifact-ref shapes chained by a domain-separated SHA-256 hash; appends
  serialize in-process and cross-process through an exclusive lock with
  bounded dead-owner and age-capped stale recovery, support compare-and-swap
  `expected_seq`, exact head dedupe, typed replay/dedupe conflicts, and full
  lattice validation before any byte is written. Publication uses
  same-directory temporaries with file fsync, atomic rename, and directory
  fsync for the journal first and the atomically published derived state
  second, so crashes leave only unpublished temporaries or a stale cache
  that exact replay rebuilds. A torn unterminated final line is the only
  healable damage; committed corruption or regression, malformed or foreign
  entries, symlinks, hardlinks, floods, oversized files, and path attacks
  fail closed with typed constant errors. The pure deterministic
  terminal-absorbing reducer projects monotonic child/run state, and opaque
  run-bound checksummed cursors page bounded event windows whose
  diagnostics stay content-free counts. There is no artifact verification,
  scheduler or provider invocation, attention reduction, supervisor/server
  wiring, cleanup/GC, semantic memory, merge authority, or protected-ref
  implementation. Coverage lives in `r1-run-journal` and
  `r1-run-journal-adversarial` tests.
- **Durable local run store and idempotent submission.** Additive
  `run-store.mjs` persists one bounded canonical record per run in an
  explicit caller-supplied existing private directory. The store fails
  closed on symlink, non-directory, and unsafe ownership or mode
  surfaces, uses strict no-follow opens, and never derives child paths
  from untrusted strings. Records bind the accepted P06 run identity,
  Git repository/base authority, initial dispatch provenance and
  telemetry facts, and request idempotency key. Exact same key plus
  canonical body returns the existing record without mutation; same
  key with a different body, same run with a different body or key,
  and mismatched protected identity fail closed with typed constant
  errors. Creates use private same-directory temporary files, complete
  writes, fsync of file and directory, and exclusive link/rename
  without overwriting an authoritative record. Restore audits
  canonical bytes and recomputes every accepted P06 digest, and
  rejects hardlinked or non-regular files, malformed JSON, duplicate
  or foreign entries, truncation, oversized records, excess entries,
  and leftover temporary files without following them. Enumeration,
  bytes, record counts, filename lengths, and diagnostics are bounded
  and never echo record contents or credentials. Concurrent duplicate
  submissions keep one authoritative mapping from run id and request
  idempotency key to the identical stored record. There is no journal
  or reducer, scheduler, provider driver, artifact store, workspace
  provisioning, cleanup, MCP wiring, or protected-ref implementation.
  Coverage lives in `r1-run-store` and `r1-run-store-adversarial`
  tests.
- **Protected identity and monotonic telemetry schemas.** Additive
  `protected-identity.mjs` / `protected-telemetry.mjs` close exact run,
  child, provider-run, workspace, and Git identities plus a content-free
  DispatchTelemetryV1 view. GitIdentityV1 is the immutable
  repository/base SHA shared by every assignment (P03 label
  `workspace-anchor.v1`); WorkspaceIdentityV1 is one managed
  worktree/branch/lock or a Cloud pin of that same base SHA (never
  direct mode). Digests bind through the P03 closed-label authority:
  P03 hex manifest/envelope digests and P05 `sha256:<hex>` capability
  and resolved-lane digests are recorded facts, not re-resolved
  routes. Request idempotency is attempt-bound and distinct from
  SelectionRequestV1. Telemetry never serializes raw identifiers,
  models, paths, prompts, results, credentials, provider references, or
  idempotency keys. Continuity allows only null-to-value fills; known
  provenance/status facts cannot be dropped or rewritten, counters and
  revisions are monotone, and settled outcomes are absorbing. Outputs
  are detached and deeply frozen. Descriptor, Proxy, accessor, symbol,
  exotic, sparse, alias, cycle, depth, and size-hostile inputs fail
  closed with typed stable errors. There is no driver mapping,
  evidence-claim surface, filesystem/network/process effect, or
  implicit authority. Coverage lives in `r1-protected-identity`,
  `r1-protected-identity-adversarial`, and `r1-protected-telemetry`
  tests.
- **Deterministic P05 resolver and P17 capability bridge.** Additive
  `resolveRunSelectionV1` / `resolveSelectionAnswersV1` bind every
  assignment's provider/model from authored explicit execution, the
  assignment-named profile, the run `profile` (omitted executions only),
  or the single catalog `default: true` record. `models` null or absent
  means membership undeclared for every provider, including DSH, and
  never invents a required list. Availability plus complete closed P17
  capability snapshot digests bind `SelectionRequestV1` identity;
  `request_id` is `sel-` plus exactly 32 lowercase hex characters. Live
  and revoked Proxies are rejected through `node:util` types before
  reflection, own `undefined` is denied, and pure answer re-resolution
  clones the caller manifest so snapshots and non-execution fields stay
  unchanged. There is no ranking, fallback, replay, hidden default, or
  provider substitution. Cursor Cloud still requires a pinned
  `starting_ref`. Coverage lives in `r1-capability-bridge`,
  `r1-resolver`, `r1-resolver-adversarial`, and
  `r1-resolver-re-resolution` tests.
- **Closed domain-separated identity digest authority.** The P03 identity
  module now owns one digest authority behind every RunIdentityV1 surface.
  `IDENTITY_LABELS` is a frozen null-prototype closed registry of the
  established `run-manifest.v1`, `assignment-prompt.v1`, and
  `child-envelope.v1` spellings plus the ratified R1 surfaces
  `run-identity.v1`, `child-identity.v1`, `resolution-snapshot.v1`,
  `resolved-lane-binding.v1`, `workspace-anchor.v1`,
  `workspace-identity.v1`, `dispatch-attempt.v1`,
  `provider-operation.v1`, `provider-run-identity.v1`,
  `request-idempotency.v1`, `provider-capability.v1`,
  `evidence-bundle.v1`, `verification-policy.v1`,
  `verification-command-descriptor.v1`,
  `verification-executable-closure.v1`,
  `verification-command-plan.v1`, and
  `verification-execution-receipt.v1`. There is no runtime registration:
  every digest path resolves its label through the registry, so arbitrary or
  unregistered labels fail with a stable `unknown_label` error before any
  byte is read. New generic `identityDigestV1(label, parts)` accepts only
  exact registry constants, requires ordinary Node Buffer parts (Proxies,
  custom prototypes, typed-array views, DataViews, ArrayBuffers,
  SharedArrayBuffers, growable ArrayBuffers, streams, getter-bearing values,
  and coercion hooks are rejected without ever running caller code), reads
  lengths and viewed backing stores through trusted `%TypedArray%` internal
  slots so spoofed `length` properties cannot lie and
  `Buffer.from(SharedArrayBuffer)` or growable-ArrayBuffer parts are
  rejected before any byte is read, snapshots bytes so later mutation cannot
  drift a digest, enforces exported caps
  `MAX_IDENTITY_DIGEST_PARTS = 16` and
  `MAX_IDENTITY_DIGEST_INPUT_BYTES = 4_194_304` with stable
  `parts_exceeded`/`unbounded_input` errors in fixed validation order, and
  returns the shared deeply frozen detached descriptor over the unchanged
  length-framed domain/version/label/parts layout. Absent and explicit-false
  diagnostic partial authorization keep identical identity bytes; exact true
  remains distinct. All existing manifest, assignment-prompt, child-envelope,
  and prompt-golden digests keep their exact bytes; adversarial coverage
  lives in `test/v3-identity-digest-authority.test.mjs`.
- **ProfileV1 whole-catalog snapshot port.** Adds the additive
  `loadProfileCatalogSnapshot(options)` API beside `loadProfiles`/`findProfile`:
  one read of both catalogs closes the merged result into a single detached,
  deeply frozen snapshot - `{ schema, catalog_digest, roots, sources, profiles,
  shadowed }` with normalized ProfileV1 records in deterministic name order -
  bound to every record's provenance digest plus one origin-aware SHA-256
  whole-catalog digest over scope presence, source files, and ordered record
  bindings. Hostile direct-JS option views and mid-read catalog drift keep the
  loader's typed rejections, a closure proof fails typed
  (`invalid_profile_snapshot_closure`) if any container were not deeply frozen,
  and per-name resolution reuses `findProfile(snapshot, name)` so run
  resolution never rereads files and no mutable Map or live object escapes.
  The snapshot adds no executable, environment, default, or route-selection
  behavior; legacy load results, lookup bytes, and digests are unchanged.
- **ProfileV1 optional primitive-true `default` flag.** Profile definitions
  accept one optional top-level `default` field as prerequisite metadata for
  later run-resolution work. When present it must be the primitive boolean
  `true` exactly: every JSON-representable non-`true` value fails closed -
  `false`, `null`, numbers, strings, objects, and arrays fail typed with
  `invalid_profile_default`, except that hostile-shaped strings inside the
  field fail earlier with their dedicated data-value scan codes. Direct-JS
  inputs outside JSON (boxed primitives, `undefined`, functions) fail earlier
  still with the generic `invalid_profile_data_value`; production behavior is
  unchanged for them. Absence is ordinary and changes nothing. The flag is bound into validated canonical data and provenance
  digests but confers no authority in this release: exact-name lookup,
  precedence, digests, and error ordering are unchanged, a profile named
  `default` has no authority by name, and P05 selection remains out of scope.
- **ProfileV1 owner and project profile loading.** Adds the data-only
  profile catalog: explicit project
  (`<repository>/.codex/co-engineer-profiles.json`) and owner
  (`<config>/codex-co-engineer/profiles.json`) roots, the
  `^[a-z0-9][a-z0-9._-]{0,63}$` profile-name grammar, deterministic
  project-over-owner precedence with reported shadowing, bounded regular
  non-symlink catalogs, duplicate-key rejection, and a stable SHA-256
  provenance digest over validated canonical data.
- **ProfileV1 provider/model/policy validation.** Profile definitions now
  validate against the additive 3.2.1 routes: known providers, DSH-only
  bounded model names (`muse-spark-1.2-contributor`,
  `stealth/ox-alpha`), `review|implement` roles, contract duration bounds,
  and data-only policy with an optional deterministic
  `pre_dispatch_provider_preference`. Unknown keys are rejected everywhere;
  credential, environment, executable/argv/shell/command-catalog,
  merge/push/create-PR authority, direct-mode, moving-ref, and
  embedded prompt/result content each fail closed with dedicated codes.
- **ProfileV1 adversarial rejection suite.** Adds a dedicated negative
  test catalog proving profiles reject credential keys and secret-shaped
  values, environment interpolation and env catalogs, executables, argv,
  shell strings, command catalogs and `VerificationPolicyV1`-shaped
  content, direct-mode workspace configuration, merge/push/create-PR and
  protected-ref authority, moving refs, embedded prompt/result content,
  symlinked or non-regular catalogs, duplicate keys, oversized catalogs,
  and non-conforming profile names.
- **R1 bounded-run architecture ADR.** Documents the accepted 3.3.0 run
  model: 1–8 independent assignments, one immutable repository/base
  identity, deterministic explicit/profile resolution, data-only profiles
  with `VerificationPolicyV1` as the sole executable command catalog, no
  direct mode for run submissions, disjoint writer scopes, read-only
  verification, no post-dispatch fallback or replay, bounded evidence,
  Codex-only final acceptance, and additive 3.2.1 compatibility. Frozen
  verified child deltas may be composed into one run-owned, single-parent,
  non-authoritative candidate; required writer lanes block a complete
  candidate when rejected or unresolved. Gate A is the full functional
  qualification contract (exact-tree/package checks necessary but not
  sufficient); Gate B/C stay advisory. Individual 3.2.1 Cloud
  `starting_ref` remains optional; every 3.3.0 run Cloud lane must pin one
  exact already-pushed provider-visible SHA.
- **Codex and worker authority threat model.** Records that selected
  providers receive the authorized full repository/history, including
  committed secrets, while platform/Git/hosting write credentials,
  unrelated environment secrets, control tokens, owner-only raw evidence,
  and unauthorized refs/remotes stay excluded; that Cursor Cloud origin
  grants are operator-authorized and not overclaimed as automatic ref
  stripping; that cgroups are lifecycle control rather than a sandbox;
  that raw evidence is owner-only/local and sanitized bounded evidence is
  model-facing; that verification may execute only `VerificationPolicyV1`
  selections; and that cleanup is manual and proof-bound, with no
  automatic GC.

### Fixed

- **Identity digest authority hardens detached backing, hostile labels,
  prototype brands, captured intrinsics, and parts-container bounds.**
  `identityDigestV1` and every dedicated RunIdentityV1 surface now normalize
  a failed trusted typed-array internal-slot read or byte snapshot — most
  importantly an otherwise ordinary Buffer whose ArrayBuffer backing store
  was detached out from under it — to one stable typed `invalid_object`
  error with a constant content-free path (`parts`) and message, so no
  native TypeError leaks and nothing is hashed; ordinary, pooled, subarray,
  empty, and caller-ArrayBuffer-backed Buffers stay accepted and byte exact.
  Digest labels now pass an O(1) code-unit type/length preflight (exported
  bound `MAX_IDENTITY_LABEL_CODE_UNITS = 64`) before the closed-registry
  lookup, so overlength, control-bearing, or secret-bearing labels are never
  hashed, scanned, truncated, or reflected: every unknown label fails with
  one constant content-free `unknown_label` diagnostic. The exact
  `MAX_IDENTITY_DIGEST_PARTS = 16` cap is enforced before any indexed
  descriptor is captured. Active and revoked Proxies are rejected first; the
  container must be an exact ordinary array whose intrinsic length is read
  O(1), and each bounded indexed data descriptor is captured exactly once
  through precomputed numeric keys. Extra string or symbol decorations are
  never enumerated or hashed, so even massively decorated under-cap arrays
  cannot drive unbounded work or change a digest. Buffer authority now
  requires the trusted Uint8Array internal brand plus exact
  `Buffer.prototype`, preventing prototype-spoofed non-byte typed arrays and
  prototype traps from swapping a validated part. Buffer/Uint8Array,
  `writeUInt32BE`, hash `update`/`digest`, JSON `stringify`, `String`, and
  reflection/collection/typed-array intrinsics are captured at clean module
  import. Existing deterministic ordering for normal arrays, total-byte/
  part-index errors, digest framing, and all manifest, assignment-prompt,
  child-envelope, run-identity, and prompt-golden digests are unchanged.
- **ProfileV1 accepts a bounded model beside every provider under one shared
  grammar.** Profile definitions now validate `model` beside any of the four
  exact providers (`grok`, `cursor-local`, `cursor-cloud`, `dsh`) whenever it
  matches the bounded model identifier grammar
  `^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$` (at most 128 UTF-8 bytes), replacing
  the DSH-only pairing that enforced two advertised model names. The static
  membership check is removed and the `PROFILE_DSH_MODELS` constant remains
  only as deprecated informational compatibility data that can never authorize
  or reject a requested model; the role vocabulary gains read-only `verify`.
  Provider, role, and model grammars are local mirrors of the assignment
  vocabulary guarded by shared test fixtures, so the profile module imports no
  run-manifest runtime module. The mirrored model grammar is exact on both
  sides: no profile-only extra clause remains (the former `..` traversal guard
  is retired), and the top-level `model` identifier is an opaque identifier -
  never parsed as a path, ref, command, or credential - validated by that
  grammar alone and therefore exempt from the generic secret/interpolation/
  shell/moving-ref value scans, while every other profile string at any depth
  stays fully scanned. Profiles still make no model-membership,
  availability, qualification, resolution, or attestation claim: attestation
  stays a preflight concern and selection stays with the resolver.
- **ChildEnvelopeV1 strict parse closes the profile-plus-model routing gap.**
  `parseChildEnvelopeV1` now rejects any `execution.model` other than `-`
  on a profile-selected execution, and symmetrically every provider/model/
  profile combination that is not exactly one compiler-emittable semantic
  state (explicit provider+model with profile `-`, or one named profile
  with provider and model both `-`), instead of silently discarding the
  hidden routing value. `envelopeRoutingSurfaceV1` framed-block exact-shape
  checks now also reject non-enumerable and symbol extra own keys, accessor
  properties, and custom prototypes at the direct-JavaScript boundary, so
  no hidden field can escape the closed shape. Canonical valid goldens are
  unchanged.
- **RunManifest identity, public classifier, and captured binding grammar.**
  `classifyAssignmentSelectionV1` now performs complete standalone
  assignment validation (ID, role/access, prompt, execution/omission,
  starting ref, scope, acceptance, duration, evidence, closed keys,
  forbidden-key scan) before returning a selection state; run-wide
  uniqueness and cross-lane writer-scope disjointness remain envelope
  validation. Present empty/partial/ambiguous/extra-key execution forms
  fail closed; only true absence defers selection. Absent and explicit
  false `return_contract.allow_diagnostic_partial_candidate` share
  complete-only canonical identity, while exact true stays
  identity-distinct, resolution-inert, and only a later
  `incomplete_candidate` authorization — never `ready_for_codex_review`.
  Identity projection walks a fully validated detached snapshot with
  captured reflection rather than caller-mutable `Object.keys`. Binding
  grammar (providers `grok,cursor-local,cursor-cloud,dsh`, roles
  `implement,review,verify`, profile/model patterns) lives in a private
  captured leaf; exports are detached informational copies. Write-scope
  ingress no longer ASCII-prefilters glob segments and delegates
  matchability to the repository matcher language.
- Close the direct-JavaScript Proxy boundary on the ProfileV1 data surfaces.
  `validateProfileDefinition`, `canonicalProfileJson`,
  `profileProvenanceDigest`, `profileRoots`, `findProfile`, and
  `loadProfiles` now reject live and revoked Proxy views with the typed
  `profile_proxy_rejected` code before any handler trap fires and before
  `Array.isArray` or any other target-inspecting builtin can raise a native
  TypeError. All nested data is read through one descriptor snapshot per
  container (never by property access), argument bags and environment views
  are snapshotted before use, and provenance digests are computed only over
  fully validated ProfileV1 canonical output, so stateful views cannot hide
  credential, argv, or merge-authority keys from validation, launder hidden
  content into a digest, or produce unstable digests. Ordinary frozen and
  null-prototype data and file-based JSON catalog loading are unchanged, and
  digest values for valid data are byte-identical to the previous release.

### Documentation

- Bumped package, plugin, marketplace, and contract surfaces to 3.3.0.
  Added GitHub Release notes in `docs/releases/v3.3.0.md`.

## [3.2.1] - 2026-08-21

Optional Ox Alpha support for DSH without changing the default Muse route or
the five-tool MCP catalog.

### Added

- **Per-task DSH model selection.** `delegate` accepts
  `dsh_model: "stealth/ox-alpha"` only when `provider` is `dsh`; omission keeps
  Muse Spark 1.2 Contributor. The selected model is retained in task, compact,
  and diagnostic receipts.
- **Separate OpenRouter configuration and credential.** Setup creates an
  owner-only Ox Alpha ACP configuration and reads its key from
  `OPENROUTER_API_KEY` or a separate owner-only key file. Muse credentials and
  configuration remain unchanged.
- **Model-metadata-aligned Ox defaults.** The generated DSH route uses
  OpenRouter's 1,048,576-token context, 131,072-token output ceiling,
  mandatory `max` reasoning, and native temperature/top-p defaults.

### Fixed

- Reject unknown DSH models and DSH-only model selection before creating a
  workspace or dispatching a prompt. Ox Alpha retains DSH's ACPX
  `dispatch_uncertain` and no-replay behavior.
- Fail explicit Ox Alpha tasks closed if ACPX cannot start instead of using the
  model-blind DSH CLI fallback.

## [3.2.0] - 2026-08-20

Measured coordination efficiency on the same five-tool catalog. Compact views,
list pagination, opt-in structured transport, bounded terminal evidence,
managed-workspace and Cursor Cloud preflight hardening, and wait-any semantics
land without changing the 3.1.1 default omitted-mode response shapes.

### Added

- **Compact task and list projections.** `task` `view: "compact"` returns a
  bounded coordination payload (8,192 UTF-8 bytes server cap). `status` and
  `tasks` accept `detail: "compact"` with bounded limits and opaque keyset
  pagination. Compact cards preserve the complete valid task ID as a reusable
  coordination key while returning only normalized state and essential timing
  evidence. Measured full JSON-RPC sizes with text duplication stay within
  readiness-only ≤8,192, compact status (20 cards) ≤24,576, and compact tasks
  page (20 cards) ≤32,768.
- **Wait-any on `tasks`.** Coordinate 1–8 exact `task_ids` with one shared
  `wait_ms` / `wait_until`. Returns bounded per-target snapshots and live event
  previews; `progress.detail_hint` points callers to single-task `task` for
  full event detail. Aggregate structured wait-any responses stay within a
  72 KiB cap.
- **Opt-in structured transport.** All five tools accept
  `response_mode: "structured"` for a bounded text fallback while
  `structuredContent` remains authoritative. Omitting the property preserves
  the exact 3.1.1 full-text duplication contract. Structured opt-in reduces
  aggregate JSON-RPC bytes by at least 30% versus the immutable 3.1.1
  duplication baseline in the efficiency harness.
- **Bounded, redacted terminal evidence.** Provider terminal results are
  secret-redacted and size-bounded, including nested objects. Clipped evidence
  reports `result_truncated` and `result_original_chars` when the source size
  is known (Unicode code points).
- **Managed workspace and Cursor Cloud preflight.** Managed local writers
  verify worktree identity before launch. Cursor Cloud preflight hardens
  provider-visible origin checks and fails closed on credential-bearing or
  unsupported origins.
- **Efficient dogfood workflow** in `docs/efficient-dogfood.md` with neutral
  example paths.

### Documentation

- Bumped package, plugin, marketplace, contract, and preflight surfaces to
  3.2.0. Added GitHub Release notes and release-validator inventory for new
  production modules (`compact-task.mjs`, `provider-result.mjs`,
  `response.mjs`) plus wait-any runtime checks.

## [3.1.1] - 2026-08-20

### Fixed

- **Unambiguous delegation argument.** The control skill, tool schema, READMEs,
  and release guidance now name the required repository argument explicitly as
  `repo` and show the literal shape
  `"repo": "/absolute/path/to/git-worktree"`. This prevents callers from
  translating the earlier prose "absolute Git root" into the unsupported
  `git_root` property and failing validation before a receipt is created.
- **Cursor Cloud argument boundary.** Documentation now distinguishes the
  always-required local checkout property `repo` from the separate Cursor
  Cloud-only `starting_ref` immutable commit SHA.

### Documentation

- Added 3.1.1 GitHub Release notes and regression checks covering the public
  skill, MCP schema, examples, marketplace version, and release metadata.

## [3.1.0] - 2026-08-19

Wait for delegated work until it reaches a terminal or needs-attention
state, without waking on routine text deltas. Deadlines are recorded with
a visible 20% margin. Diagnostics, deadline extension, and reply are
parameters on the existing five-tool catalog.

**Limitation:** 5-minute, 30-minute, and 4-hour Codex Desktop measurements
were not executed in this worktree. The 4-hour MCP pending-call budget is
advertised, not a measured Desktop hard limit. If the host cuts the call
earlier, reconnect from `event_cursor`.

### Added

- **Recorded deadlines.** `delegate` records `expected_duration_ms`, a
  visible 20% margin, and
  `deadline_at = created_at + ceil(expected_duration_ms * 1.20)`. Explicit
  `timeout_ms` overrides are stored as `deadline_source: "explicit"`.
  Deadline extensions require `extend_expected_duration_ms` plus
  `extend_reason` and are appended to `deadline_extensions`; the deadline
  is never rolled silently.
- **Terminal waits.** `task` `wait_until: "terminal"` waits for a terminal
  or needs-attention state without waking on routine text deltas.
  Disconnecting the waiter or cancelling the MCP call does not stop or
  own provider work.
- **Summary and diagnostics views** on `task`. Diagnostics are
  side-effect free, cursor-paged, byte-capped, and secret-redacted.
  Alerts use a normalized diagnostic envelope instead of a bare `ERROR`.
- **Same-session, exactly-once `task.reply`** for Grok and Cursor Local
  ACP sessions. DSH, Cursor Cloud, and CLI fallback report
  `same_session_reply_unsupported` rather than starting a new prompt.
- **Provider capability reporting** on `status` and task receipts,
  including live progress, reply, restart recovery, cancellation
  confirmation, and evidence class.
- **Durable restart reconciliation** of unfinished tasks, including
  deadline expiry when the worker is gone and immediate wake when
  attention is still required.
- **Deterministic MCP pending-call probe** and a documented real-host
  acceptance procedure. 5-minute, 30-minute, and 4-hour Codex Desktop
  measurements were not executed in this worktree.

### Fixed

- **Deadline margin.** Keep expected-duration and timeout maxima separate
  so the recorded deadline is always at least
  `ceil(expected_duration_ms * 1.20)` instead of silently capping the
  margin. Explicit `timeout_ms` must meet that floor. `delegate` requires
  `expected_duration_ms` or a backwards-compatible `timeout_ms`.
- **Strict extensions.** Reject deadline extensions that would not move
  `deadline_at` strictly later.
- **Diagnostics paging.** Skip a single oversized event line and advance
  the cursor; last-activity reads the event-log tail in bounded chunks.
- **Reply watchers.** Same-session reply watchers attach an error handler,
  re-arm once, then use the low-frequency fallback. Unmatched reply text
  fails closed to `cancel`.
- **Secret redaction.** Public MCP receipts redact secrets in `result`,
  errors, nested handoff, and events.
- **Lifecycle evidence.** Public receipt sanitization keeps
  `prompt_dispatched` lifecycle evidence while still omitting raw prompt
  content.
- **Cursor Cloud waits.** Run-completion waits re-arm when an audited
  deadline extension is persisted.
- **Omitted terminal waits.** Omitted `wait_until=terminal` waits re-read
  `deadline_at` and re-arm the task-deadline timer when another client
  records an audited extension. Explicit `wait_ms` remains a fixed
  caller-selected connection cap.
- **Pinned DSH setup.** Pin vendored DSH ACP demo peerDependencies to
  exact `0.1.0-rc.7` and install that same composition explicitly so
  `npm run setup` cannot resolve a later release candidate such as
  `dsh-acp@0.1.0-rc.8`.

### Changed

- **Five-tool catalog unchanged.** Terminal wait, diagnostics, deadline
  extension, and reply are parameters on `task` / `delegate`.
- **Advertised 4-hour pending-call budget.** Raise the plugin-advertised
  MCP pending-call budget to 4 hours (`wait_ms` max 14400000,
  `tool_timeout_sec` 14405). This is an advertised budget, not a measured
  Desktop hard limit. If the host cuts the call earlier, reconnect from
  `event_cursor`.
- **15-second watcher fallback.** Watcher failure during a terminal wait
  uses a 15-second local fallback rather than rapid polling.

### Documentation

- Copy/paste-first clone, Codex plugin, setup, and first-run flow for a
  fresh visitor. The repository marketplace catalog is
  `.agents/plugins/marketplace.json`.
- Product shot and a maintainable SVG of delegate / wait / terminal
  receipt. GitHub-ready release notes live in
  `docs/releases/v3.1.0.md`.

## [3.0.2] - 2026-08-19

### Fixed

- Project a compact live `last_event` / `progress` snapshot from the
  append-only event log so `task` and `status` no longer stay stale while
  ACP workers are streaming. `task.json` is still not rewritten on every
  text delta.
- Extend `task` with optional bounded `wait_ms` and `cursor` wait
  arguments so Codex can wait for meaningful progress or a terminal state
  instead of hammering empty polls. Waits are event-driven; text deltas
  are coalesced and event-log catch-up is memory-bounded. Unsolicited
  stdio callbacks across assistant turns are not available.
- Read the configured `remote.origin.url` for Cursor Cloud so host
  `insteadOf` credential rewrites cannot leak into receipts or fail
  dispatch.

### Changed

- Adopt `codex-co-engineer` as the package, plugin, MCP server, skill, and
  repository-path identifier. Human-facing branding is Codex-Co-Engineer.
- Remove leftover environment fallbacks and vendor package names from the
  previous identity.
- Rewrite the root and plugin READMEs around the current 3.x supervisor,
  provider matrix, workspace model, and discovery/install paths.

## [3.0.1] - 2026-08-19

### Fixed

- Forward the user-session runtime and D-Bus locators required by transient
  `systemd --user` services when Codex applies the plugin environment
  allowlist.
- Report local process-boundary readiness through `status` and fail local
  providers closed before creating a worktree, task receipt, or prompt file.
- Wait for the `systemd-run` client result so queueing failures are classified
  accurately instead of surfacing as a later unit-inspection failure.
- Keep the stdio server alive while its newly connected client prepares the
  first JSON-RPC frame.
- Exercise the exact manifest-filtered MCP environment in the authoritative
  release gate.

## [3.0.0] - 2026-08-19

### Added

- Five-tool multi-agent supervisor for Grok Build, Cursor Local, Cursor Cloud,
  and DeepSeek Harness/Muse.
- ACP-first local execution, official Cursor SDK cloud execution, and a
  cohesive official DSH rc.7 ACP composition.
- Persistent normal provider authentication with owner-only local credential
  discovery; no credentials in MCP arguments or receipts.
- Managed `worktree-bootstrap` workspaces for every local review and
  implementation task.
- Durable task receipts, stable cloud idempotency, restart reconciliation, and
  bounded process-group and remote-run cancellation.
- One setup/check command for pinned local dependencies and DSH configuration.

### Changed

- Codex is explicitly the chief engineer and merge authority; peer providers
  retain normal coding, shell, and dependency-installation capabilities.
- Cursor Local and Cursor Cloud are both first-class providers in the main
  Co-Engineer plugin.
- CLI fallback is limited to failures proven to occur before prompt dispatch.
- Release validation now tests the five-tool 3.x catalog and package instead of
  the 2.x target-attestation and outer-sandbox experiments.

### Removed

- The seven-tool 2.x control plane, target fingerprints, capacity subsystem,
  daemon/runtime UI controls, direct-headless policy layer, and experimental
  Bubblewrap/attestation outer-sandbox paths. Local workers retain only a
  lifecycle-only systemd user-scope cgroup boundary for descendant cleanup;
  it is not a provider sandbox or an attested execution boundary.
- Packaged legacy MCP modules, tests, and DSH headless overlays.

## [2.1.2] - 2026-08-18

- Final 2.x target-bound Co-Engineer and Cursor compatibility release.

## [1.0.0] - 2026-08-16

- Initial public Codex-Co-Engineer release.
