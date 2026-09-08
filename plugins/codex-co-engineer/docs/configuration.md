# Configuration

Give Codex a team of external co-engineers without giving up control.

Codex-Co-Engineer has no executable project policy file. The only
project-scoped configuration data is the data-only ProfileV1 catalog
described in [Profiles](#profiles); verification commands never come from
profiles and remain a separate owner-maintained `VerificationPolicyV1`.
The approved-command resolver consumes that owner policy plus a closed
Codex/owner `command_id` selection and returns a frozen ExecutionIntent
receipt; it does not execute the command. The constrained verification
runner consumes only a genuine approved-command receipt plus that trusted
policy, runs the exact owner-approved executable and argv once in a
disposable workspace separate from the candidate, and records bounded
sanitized host-observed evidence. It is not wired into the MCP server.
Provider authentication is normal persistent login/session state or an
owner-only key file. The setup command installs the pinned local
composition and creates the default DSH configuration; it never performs
login on the user's behalf.

Normal users speak ordinary language (`Delegating to Co-Engineer`,
`Chatting with Co-Engineer`, `Using Grok Co-Engineer`, `Using Cursor
Co-Engineer`, `Using Muse Co-Engineer`). They do not write tool
payloads. JSON in this file belongs under
[Advanced Co-Engineer Control/API](#advanced-co-engineer-controlapi).

Visitor first-run speech lives in the
[repository README](../README.md) and
[quickstart](co-engineer-quickstart.md).

## Host environment

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Absolute owner-only task-state root. Defaults to the XDG state directory. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok CLI executable. Defaults to `grok`. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable. Defaults to `cursor-agent`. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable. Defaults to `dsh`. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable used for DSH. Defaults to `acpx`. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP adapter executable. Defaults to `dsh-acp-demo`. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | Absolute DSH ACP YAML path. |
| `CODEX_CO_ENGINEER_DSH_OX_ACP_CONFIG` | Absolute Ox Alpha DSH ACP YAML path. |
| `CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE` | Owner-only OpenRouter key file for DSH Muse and Ox Alpha. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud API key file. |
| `OPENROUTER_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY` | Optional process-level provider credentials. |

The default DSH configuration is
`~/.config/codex-co-engineer/dsh-acp.yml`; its OpenRouter key defaults to
`~/.config/codex-co-engineer/openrouter-api-key`. Setup also creates the
optional Ox Alpha configuration at
`~/.config/codex-co-engineer/dsh-acp-ox-alpha.yml`, using that same
OpenRouter key while keeping a separate model/config route. Cursor
Cloud also recognizes the existing owner-only
`~/.config/cursor-cloud-control/api-key`.

The visitor install is clone-first. From a repository checkout:

```bash
codex plugin marketplace add "$PWD"
codex plugin add codex-co-engineer@codex-co-engineer
npm --prefix plugins/codex-co-engineer run setup
npm --prefix plugins/codex-co-engineer run setup:check
```

The same setup scripts also run from `plugins/codex-co-engineer` as
`npm run setup` and `npm run setup:check`. See the [repository
README](../README.md) for the first-run flow.

The package supports Node.js 24 and newer. The exact release gate is
pinned to Node.js 24 so release receipts are reproducible.

Local worker launch additionally requires Linux with a working
`systemd --user` manager, `systemd-run` 244 or newer, and a unified
cgroup v2 hierarchy. The manager-owned transient systemd user service
uses `KillMode=control-group` only to make cancellation reach detached
descendants and let the worker survive the launching client; it is not a
sandbox and does not restrict environment, network, filesystem,
credentials, or provider shell capabilities. Local dispatch fails closed
when this boundary cannot be verified.

`npm run setup:check` validates the DSH/ACPX composition and CLI, Cursor
SDK, and `worktree-bootstrap` dependency. It does not install or
authenticate Grok or Cursor Local or validate the Cursor Cloud key. Ask
Codex to show Co-Engineer status after setup. Its `local_boundary`
object validates the systemd/cgroup prerequisite in the MCP process's
real environment; Grok, Cursor Local, and DSH are forced to
`ready: false` when the boundary is unavailable. Local delegation
repeats the check before creating any workspace or task artifact. The
release gate also tests a server launched with only the MCP manifest's
allowlisted environment.

Any extra Co-Engineer panel is optional, feature-detected, and
host-specific. Headless Codex CLI remains a complete fallback.

## Luna Max project manager

Delegating to Co-Engineer and Chatting with Co-Engineer treat a
user-authorized pinned Luna Max task as the default routine project
manager. That is skill policy. It is not a sixth public skill, a sixth
MCP tool, or a change to the Co-Engineer run/event transport.

The skill can guarantee policy. Codex is the host executor for Desktop
task tools. The JS adapter plans and validates those call shapes and
does not invoke host callbacks. Co-Engineer MCP still cannot invoke
those host-only tools and must not add a sixth tool to simulate the
Desktop host.

The skill can guarantee:

- one Co-Engineer submission, one `decision_or_attention` wait
- no model polling on the Co-Engineer transport
- Luna Max as the default manager when the user authorizes a pinned
  task and Luna Max is actually available
- wake on completed, blocked, failed, question, timeout, or
  user_update; never on routine progress
- a distinct `merge_ready` envelope that may wake Sol High or Sol
  XHigh exactly once, and only when exact head and tree, verifier
  acceptance, current green CI, zero failed or hidden checks, and
  topology facts all pass
- exact identity binding with a monotonic cursor and a bounded
  recent-id window, never an unbounded seen-event list
- grouped attention that retains a routing tuple for every
  question_id and routes one structured response covering all
  answerable questions exactly once
- bounded sanitized evidence references or artifact_ref spill, never
  raw transcripts or secrets
- Luna-native read-only subagents for local analysis only, depth at
  most 2, counted against the eight-lane ceiling, never a duplicate
  external writer assignment
- Sol Medium is not a mandatory layer
- external workers may commit; a scoped publisher may non-force push
  only the task branch and open a draft PR; Sol High or Sol XHigh
  alone performs regular merge after deterministic exact-head,
  current-green-CI, and topology checks; the user retains release,
  tag, version, and protected-ref authority
- no worker or message can force-push, merge, rebase, tag, release,
  delete refs, or override verification
- honest continuation in the current Codex task when the manager
  cannot be pinned

The following remain host-dependent Codex Desktop task-management
capabilities. Codex executes them. The JS adapter feature-detects and
validates their live call shapes and does not invent them. Co-Engineer
MCP cannot invoke these host-only tools:

- `create_thread`, which is usable only with `threadId` and `hostId`.
  A result containing only `clientThreadId` is setup-pending; do not
  send or wait until the host supplies a real `threadId` and `hostId`
- `send_message_to_thread`, which requires `threadId` plus a real
  prompt body
- `wait_threads` with `targets` that MUST include `threadId` and MAY
  include `hostId` and `afterCursor`, plus a bounded timeout, or
  `read_thread`
- optional `set_thread_archived` or `set_thread_pinned`
- binding the actual thread id, host id, and cursor the host returns
- availability of Luna Max, Sol High, or Sol XHigh on the host

The host has no cancel primitive. Do not invent `cancel_thread`,
`archive_thread`, or `pin_thread`, and do not claim cancellation
support.

If those tools or Luna Max are missing, Codex reports the degraded
mode and continues in the current Codex task. It never silently
substitutes Sol or another model. Explicit user model overrides and
Grok, Cursor, or Muse co-engineer selection stay intact. There is no
learned routing or semantic memory. Luna does not merge. External
workers may commit. A scoped publisher may non-force push only the
task branch and open a draft PR. Sol High or Sol XHigh alone performs
regular merge after exact-head, current-green-CI, and topology checks.
The user retains release, tag, version, and protected-ref authority.

## Profiles

Profiles are owner-authored, data-only selection records used by the
deterministic run resolver. A profile may name a provider, a model, a
role, an expected duration, and bounded non-executable selection policy.
A profile **MUST NOT** define executables, argv, shell strings, command
templates or catalogs (including anything shaped like
`VerificationPolicyV1`), credentials, tokens, secrets, environment
values, moving refs, direct-mode workspace configuration,
merge/push/create-PR authority, or embedded prompt/result content.

There are exactly two roots:

| Scope | Path |
| --- | --- |
| Project | `<repository>/.codex/co-engineer-profiles.json` |
| Owner | `<XDG_CONFIG_HOME|$HOME/.config|os.homedir()/.config>/codex-co-engineer/profiles.json` |

Profile names match `^[a-z0-9][a-z0-9._-]{0,63}$`. Catalog files must be
regular non-symlink files of at most 64 KiB holding at most 64 profiles;
duplicate JSON keys are rejected instead of silently last-wins.
Precedence is fixed and deterministic: when both scopes define the same
name, the project record applies and the owner record is reported as
deterministically shadowed. Every loaded profile carries a stable
SHA-256 provenance digest computed over its validated canonical form
plus its exact name, so identical data yields identical digests
regardless of key order or whitespace. The owner-scope directory and
catalog must be owned by the current user and must not be writable by
group or other users. Project-scope ownership follows the repository's
normal access policy.

The optional `default: true` flag is ordinary to omit. The resolver
applies it only after explicit execution, an assignment-named profile,
and the run `profile` leave an omitted execution unresolved. A profile
whose name is `default` still has no authority by name.

### Field validation

Profiles validate against one bounded run grammar shared with assignment
manifests. The grammar is mirrored locally in the profile module and
guarded against drift by shared test fixtures; profile loading imports
no run-manifest runtime module.

- `provider` is one of `dsh`, `grok`, `cursor-local`, `cursor-cloud`.
  Public speech for those slots is Using Muse Co-Engineer, Using Grok
  Co-Engineer, and Using Cursor Co-Engineer (Cursor Local and Cursor
  Cloud both display as Cursor Co-Engineer).
- `model` may be named beside any explicit provider from that list and
  must match the bounded model identifier grammar
  `^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$` (at most 128 UTF-8 bytes). The
  check is syntax and requested-byte size only: profiles carry no
  model-membership, availability, qualification, resolution, or
  attestation data, and no advertised-model list is ever enforced
  against a requested model. Whether a provider actually offers the
  named model is attested at preflight, not at authoring time. The
  `PROFILE_DSH_MODELS` constant survives only as deprecated
  informational compatibility data and is never consulted by validation.
- `role` is `review`, `implement`, or `verify` (read-only verification).
- `expected_duration_ms` is an integer from 1,000 to 86,400,000.
- `default` is optional. When present it must be the primitive boolean
  `true` exactly; absence is ordinary. Lookup stays exact-name and a
  profile named `default` has no authority by name. The resolver may
  use the single `default: true` catalog record only for a truly omitted
  execution that neither the assignment profile nor the run `profile`
  resolved. Two `default: true` records fail closed; the resolver never
  ranks defaults.
- `policy` is data-only selection policy. Today it may contain exactly
  `pre_dispatch_provider_preference`: one to four unique known provider
  names in the owner's deterministic pre-dispatch preference order.

Unknown fields are rejected at every level. Fields naming credentials,
environment values, executables/argv/shell/command catalogs or
templates, merge/push/create-PR or protected-ref authority, moving refs,
direct-mode workspace configuration, or embedded prompt/result content
fail closed with dedicated error codes, as do string values that look
like secret material, environment interpolation, shell syntax, or a
branch/ref name - except the grammar-governed top-level `model`
identifier itself, which is an opaque identifier validated only by the
bounded model grammar above, never parsed as a path, ref, command, or
credential.

Profiles only name selections. `resolveRunSelectionV1` is the
deterministic resolver: explicit assignment `execution.provider`/`model`
wins, then the assignment-named profile, then the run `profile` for
omitted executions, then the single `default: true` record. Availability
`models` null or absent means membership is undeclared for every
provider, including DSH. Unsupported, unavailable, and `not_supported`
routes stay unresolved and are never substituted. Cursor Cloud lanes
still require one pinned already-pushed `starting_ref`. Provider/model
attestation of the effective pair remains a later preflight concern.

Missing selection in the visitor path is one ask for Grok, Cursor, or
Muse. Codex does not invent a default router.

## Authentication

Authenticate Grok and Cursor Local with their normal CLIs. DSH Muse and DSH
Ox Alpha use the owner-only OpenRouter key, and Cursor Cloud uses its normal
API key. Credentials
must not be placed in MCP arguments, prompts, receipts, fixtures, or
Git. Provider login state persists in the provider's normal user
configuration between Codex tasks.

## State and retention

Task records, prompts, events, worker logs, runtime identities, and
session data live under the owner-only state root
`$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer`. Task directories are `0700`; files
are `0600`. Terminal task state is retained until the operator removes
that exact task directory after handoff and review. Never delete the
whole state root or another task's state as cleanup.

## Advanced Co-Engineer Control/API

This section is for operators and Codex internals. Normal users do not
construct these payloads. The five-tool catalog remains `status`,
`delegate`, `task`, `tasks`, and `cancel`. There is no sixth tool.

### Profile catalog example

```json
{
  "deep-security-review": {
    "schema": "codex-co-engineer.profile.v1",
    "provider": "dsh",
    "model": "stealth/ox-alpha",
    "role": "implement",
    "expected_duration_ms": 1200000,
    "default": true
  }
}
```

### Whole-catalog snapshots

`loadProfileCatalogSnapshot(options)` takes the same arguments as
`loadProfiles` and reads both catalogs exactly once. It returns one
detached, deeply frozen snapshot `{ schema, catalog_digest, roots,
sources, profiles, shadowed }`: `profiles` lists normalized ProfileV1
records (`name`, `scope`, `source`, `definition`, `digest`) in
deterministic name order, `shadowed` keeps project-precedence losers
visible, and `catalog_digest` binds the whole ordered catalog - each
scope's presence and exact source file plus every record's provenance
digest - so content, precedence, ordering, presence, or origin drift
yields a different digest. Per-record provenance digests stay
content-only and path-independent. The snapshot carries no executable,
environment, default, or route-selection behavior; per-name resolution
reuses `findProfile(snapshot, name)`, so a run resolves its
`run_profile` plus every assignment profile from that one read without
rereading files, and no mutable Map or live object escapes the boundary.

### Run selection

`resolveRunSelectionV1` consumes one parsed run manifest, one
availability snapshot, one complete capability snapshot, and an optional
branded or load-shaped profile catalog. It never ranks, scores, falls
back, replays, or substitutes a provider. `SelectionRequestV1` identity
binds both recomputed snapshot digests; `request_id` is `sel-` plus
exactly 32 lowercase hex characters. `resolveSelectionAnswersV1` is
pure: an accepted answer batch re-resolves a cloned manifest, echoes the
outstanding request identity, and leaves the original manifest and
snapshots unchanged.

### Task inputs

Repository paths, prompts, roles, deadlines, and workspace/PR intent are
inputs to `delegate`; they are not global policy. The absolute Git
worktree path must be passed in the property named `repo`, for example
`"repo": "/absolute/path/to/git-worktree"`. Do not rename it to
`git_root` or `repository`; the strict MCP schema rejects unknown
properties. Pass `expected_duration_ms` or a backwards-compatible
`timeout_ms` so the recorded deadline is
`ceil(expected_duration_ms * 1.20)` unless an explicit `timeout_ms` of
at least that margin is supplied.

DSH uses `meta/muse-spark-1.3-contributor` with xhigh reasoning when
`dsh_model` is omitted. To
select Ox Alpha for one task, keep `provider: "dsh"` and add
`dsh_model: "stealth/ox-alpha"`. The field is rejected for other
providers and unknown model values fail before workspace creation or
prompt dispatch:

```json
{
  "task_id": "ox-review",
  "provider": "dsh",
  "dsh_model": "stealth/ox-alpha",
  "repo": "/absolute/path/to/git-worktree",
  "prompt": "Review the current branch.",
  "expected_duration_ms": 600000
}
```

The bundled Ox profile follows OpenRouter's model metadata: a
1,048,576-token context, a 131,072-token output ceiling, mandatory
reasoning at `max`, and the provider's native temperature `1` / top-p
`0.95` defaults. DSH ACP supports text and raster-image prompts, so the
profile does not over-advertise the model's separate video input
capability.

For routine coordination, use `task` with `view: "compact"`, or `status`
and `tasks` with `detail: "compact"`. Compact status/task pages preserve
each full task ID so the returned key can be passed unchanged to `task`,
`cancel`, or a wait-any call. `status` accepts `include_tasks` and
`task_limit`; `tasks` accepts a bounded `limit`, opaque keyset `cursor`,
and provider/state filters. To wait for the first change among 1–8 exact
tasks, pass `task_ids`, optional per-task `cursors`, and one shared
`wait_ms` / `wait_until` to `tasks`. Do not mix wait-any fields with
list pagination or filters.

`task` accepts `wait_until` (`progress` or `terminal`), optional
`wait_ms` (0-14400000), `cursor`, `view` (`summary`, `diagnostics`, or
`compact`), audited deadline extension fields, and a same-session
`reply` object. Terminal waits are event-driven and do not wake on
routine text. Diagnostics are side-effect-free and redacted. Clients
that actually consume `structuredContent` may opt into
`response_mode: "structured"` on any tool; otherwise omit it to preserve
the default compatible text receipt. The server does not stream raw
events or emit unsolicited stdio callbacks across assistant turns. See
[MCP pending-call budget](mcp-pending-call.md) and the
[efficient dogfood workflow](efficient-dogfood.md).

### Bounded runs (additive)

The five-tool catalog does not gain a sixth tool. One run is submitted
through `delegate.run_request` with 1–8 lanes. The legacy full `delegate.run`
envelope remains accepted for compatibility, but skills do not construct it.
`status`, `task`, `tasks`, and
`cancel` accept `run_id` to inspect, wait (`wait_until:
"decision_or_attention"`), latch attention, reply exactly once
(`run_reply`), cancel named lanes, or request proof-bound `cleanup`.
Omitted run fields keep the 3.2.1 shapes above, including `view:
"compact"`, `detail: "compact"`, `task_ids` wait-any, and
`response_mode: "structured"`. Provider/model is explicit or filled from
one named profile; mixed explicit/profile values fail closed when they
conflict. The future-harness template is not a provider; parsing
failures dispatch nothing. `decision_or_attention` waits until an
attention or terminal decision (or `wait_ms`). See
[the run tool API](run-tool-api.md).

### Local providers

`workspace_mode: "managed"` is the default. It creates one locked
`worktree-bootstrap` worktree and branch per task. Set
`workspace_mode: "direct"` only when direct mutation of the supplied
checkout is intentional. Direct mode does not create a disposable
worktree. Bounded-run submissions reject direct mode.

### Cursor Cloud

Cursor Cloud still requires `repo`, identifying the clean local checkout
with a provider-accessible Git origin. It additionally requires an exact
immutable commit SHA in the separate Cursor Cloud-only `starting_ref`
property for every bounded-run Cloud lane. The SHA must already be
pushed; a local branch name or unpushed work is not an acceptable cloud
starting point. Individual 3.2.1 Cursor Cloud tasks still treat
`starting_ref` as optional.
An exact SHA reachable only from a feature branch can remain invisible
to Cursor until the branch is provider-visible through an open pull
request or the default branch. Create the draft PR (or make the commit
reachable from the default branch) before final Cloud acceptance.
Surface an HTTP 400 for an otherwise-valid SHA as a provider visibility
failure and fix reachability before retrying.
`create_pr` is supported only for Cursor Cloud and defaults to `false`.
Local tasks reject `create_pr`; Codex inspects their handoff and commits
before deciding whether to push or open a PR.
