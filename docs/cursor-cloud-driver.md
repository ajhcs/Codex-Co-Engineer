# Cursor Cloud SDK provider driver (P21)

Status: implemented against an injected bounded Cursor SDK transport port.
Not real-transport qualified.

The P21 `CursorCloudDriverV1` (`plugins/codex-co-engineer/mcp/v3/cursor-cloud-driver.mjs`)
is the Cursor Cloud adapter over the accepted P17 `ProviderDriverV1`
contract. It owns only the Cloud-specific wiring; every request/result
shape, capability posture, transition rule, and denial code is inherited
from the accepted contract. It defines no parallel envelope or capability
schema. Existing `mcp/v3/cursor-cloud-worker.mjs` is unchanged.

## Hard binding

- Provider slot: `cursor-cloud` exactly. Every other provider fails closed
  with `provider_slot_mismatch`.
- Exact requested and effective model: preflight is ready only when the
  transport attests the envelope model on both `requested_model` and
  `effective_model`. Substitution is `model_unattested`.
- Workspace: remote provider-managed, starting at a pinned pushed SHA. The
  envelope `starting_ref` must be a lowercase 40-hex commit identical to
  the immutable run `base_sha`.
- Repository identity: credential-free host/path plus https URL. Credentials,
  query, fragment, and mutable/duplicate identities fail closed.

## Honest capability

The shipped declaration is fixed to:

- `workspace_semantics: remote_provider_managed`
- `workspace_starting_point: pinned_pushed_sha`
- `exact_model_selection: exact_and_attested`
- `dispatch_certainty: confirmed_launch`
- `same_session_reply: unsupported_unresolved_attention`
- `create_pr_posture: prohibited`
- `merge_authority: none_codex_only_integration`
- `replay_posture: never_replay`

Concretely:

- Launch reports `dispatched` only after an authoritative SDK run identity:
  cloud agent id, provider run id, and stable request id, plus branch
  identity.
- Any uncertainty after create or send intent is `dispatch_uncertain` and is
  never replayed, retried, or fallback-substituted.
- Same-session reply is unsupported. Reconcile surfaces pending questions as
  `unresolved_attention` and never starts a replacement run.
- `auto_create_pr` is always `false`. Merge, create-PR, and push keys fail
  closed.

## Preflight rejections

Preflight blocks (closed detail pair, no transport-authored text):

- dirty checkout
- absent origin
- non-commit starting ref
- invisible starting SHA
- base advancement (`head_sha` or starting SHA drifted from the pin)
- unattested model

Preflight throws (security/identity):

- credential-bearing repository identity
- ambiguous duplicate identities
- automatic PR authorization

## Injected bounded SDK transport port

`createCursorCloudDriverV1(transport)` / `bindCursorCloudDriverV1(transport)`
require a plain record exposing exactly six concrete synchronous functions
(Proxies, accessors, exotic prototypes, missing or extra operations are
denied):

| Operation   | Argument (frozen, bounded) | Receipt |
| ----------- | -------------------------- | ------- |
| `preflight` | child identity + starting SHA | workspace cleanliness, visibility, attested model, repository identity |
| `create`    | identity + `auto_create_pr: false` | `{ created, agent_id, ...identity }` |
| `send`      | identity + `agent_id` + `request_id` + envelope text | `{ acknowledged, agent_id, provider_run_id, request_id, branch, ...identity }` |
| `observe`   | exact recorded agent/run/request identity | status plus independently verifiable Git/branch/base evidence |
| `cancel`    | exact recorded agent/run/request identity | `{ outcome, archived, ...identity }` |
| `reattach`  | exact recorded agent/run/request identity | `{ reattached, agent_id, provider_run_id, request_id, ...identity }` |

Reconcile mapping: `running → in_progress`, `needs_attention →
unresolved_attention`, `completed/failed/cancelled → terminal` after Git
evidence verification, `lost → dispatch_uncertain`. Terminal verification
requires provider-reported state plus head SHA, merge-base, and branch.
The adapter claims nothing the transport did not expose.

`restart_reattach` recovers only the exact recorded agent/run/request
identity and never relaunches.

## Cancellation and terminal latches

Cancel targets only the exact recorded run. The receipt must report both
`outcome` (`cancel_requested` / `cancel_confirmed` / `already_terminal`) and
a boolean `archived`. `cancel_requested` stays nonterminal so a later cancel
may still be delivered. Completed/failed/cancelled observe status and
`cancel_confirmed` / `already_terminal` latch: later cancel is
`already_terminal` with no further transport.

## Bounds and telemetry hygiene

Event pages are at most 32 records of `{ kind, bytes }` from a closed kind
vocabulary. Detail messages are composed only from closed vocabulary words
and validated identifiers. Provider prompt, envelope text, secrets, PR URLs,
and transport-authored strings never reach a driver result, a detail pair,
or inspectable evidence.

## Coverage and non-claims

Coverage lives in `test/r1-cursor-cloud-driver.test.mjs` and
`test/r1-cursor-cloud-driver-adversarial.test.mjs`.

This slice does NOT qualify a real Cursor Cloud transport. It claims no
durable store, scheduler, registry cutover, supervisor cutover, merge
authority, or automatic PR creation. One Luna Max exact review follows;
real Cursor Cloud transport qualification follows exact acceptance.
