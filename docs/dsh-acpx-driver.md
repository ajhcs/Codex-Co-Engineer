# DSH ACPX provider driver (P20)

Status: implemented against an injected bounded one-shot transport port.
Not real-transport qualified.

The P20 `DshApxDriverV1` (`plugins/codex-co-engineer/mcp/v3/dsh-acpx-driver.mjs`)
is the DeepSeek Harness (DSH) adapter over the accepted P17
`ProviderDriverV1` contract. It owns only the DSH-specific wiring; every
request/result shape, capability posture, transition rule, and denial code is
inherited from the accepted contract. It defines no parallel envelope or
capability schema.

## Hard binding

- Provider slot: `dsh` exactly. Every other provider fails closed with
  `provider_slot_mismatch`.
- Models: `meta/muse-spark-1.3-contributor` or `stealth/ox-alpha` exactly. Any
  other model fails closed with `dsh_model_denied`. The Muse model uses
  xhigh reasoning. The informational identity map mirrors the shipped
  supervisor routing (`dsh-acp.yml` + `OPENROUTER_API_KEY` /
  `openrouter-api-key`; `dsh-acp-ox-alpha.yml` + `OPENROUTER_API_KEY` /
  `openrouter-api-key`) but resolves nothing by itself.
- Workspace: `workspace_mode: "managed"` at construction (required, no hidden
  default), local managed worktree semantics anchored at the immutable run base
  SHA. Direct mode fails closed with `direct_mode_rejected`.

## Honest uncertainty

ACPX provides no authoritative prompt-sent acknowledgement, so the capability
declaration is fixed to `dispatch_certainty: uncertain_after_spawn`,
`replay_posture: never_replay`,
`same_session_reply: unsupported_unresolved_attention`,
`create_pr_posture: prohibited`, and
`merge_authority: none_codex_only_integration`. Concretely:

- A launch that reaches the spawn intent returns `dispatch_uncertain` even when
  the port accepts the spawn. There is no `dispatched` result on this surface.
- Any post-intent exception or loss stays `dispatch_uncertain` and is never
  replayed, retried, or fallback-substituted onto this or another transport;
  the P17 lane state lands in a possibly-sent state so duplicate launches are
  denied with `replay_denied`.
- Only a provably pre-spawn failure may report `not_sent`: either the failure
  happens before the spawn call was ever made (for example a lost identity
  probe), or the port throws an error carrying own data properties
  `phase: "prespawn"` plus a bounded `code`. Getters, exotic prototypes,
  subclasses, and partial markers are treated as unprovable and stay
  uncertain. At most `DSH_MAX_LAUNCH_ATTEMPTS = 2` launch attempts exist per
  lane; further attempts fail with `launch_budget_exceeded`.
- Same-session reply is unsupported. Reconcile surfaces pending questions as
  `unresolved_attention`; the driver never answers them, never starts a
  replacement prompt, and never opens a replacement session.

## Injected bounded one-shot transport port

`createDshApxDriverV1({ transport, workspace_mode, now? })` requires a plain
record exposing exactly five concrete synchronous functions (Proxies, accessors,
exotic prototypes, missing or extra operations are denied):

| Operation        | Argument (frozen, bounded)                                             | Receipt (validated, closed keys) |
| ---------------- | ---------------------------------------------------------------------- | -------------------------------- |
| `configIdentity` | `{ model }`                                                             | `{ ready, reason?, config_path?, config_sha256?, credential_source?, credential_sha256? }` |
| `spawn`          | `{ model, run_id, assignment_id, lane_index, base_sha, child_envelope_digest, envelope_text, attempted_at_ms }` | `{ session_ref, observed_at_ms? }` |
| `poll`           | `{ session_ref, correlation }` where correlation restates the exact child identity | `{ ...correlation, session_ref, state, stop_reason?, question_ref?, event_count, cursor, updated_at_ms }` |
| `events`         | `{ session_ref, correlation, cursor, max_records }`                     | `{ records: [{ seq, kind, bytes }], next_cursor, truncated }` |
| `cancel`         | `{ session_ref, correlation }`                                          | `{ ...correlation, session_ref, outcome }` |

Recorded-evidence vocabulary the port must project raw ACPX output into:

- `state`: `absent | accepted | running | needs_attention | completed | failed |
  cancelled`
- `stop_reason` (terminal states only): `end_turn | cancelled | timeout | error`
- event `kind`: `text_delta | thought_delta | tool_call | tool_call_update |
  status | usage | attention`
- cancel `outcome`: `confirmed | requested | already_terminal`

Reconcile mapping: `accepted/running → in_progress`, `needs_attention →
unresolved_attention`, terminal states → `terminal`, everything else (including
lost evidence and intent-only lanes without a session handle) →
`dispatch_uncertain`. `restart_reattach` is reconcile-only recovery from
recorded evidence; missing evidence reports `restart_evidence_absent` and never
relaunches.

## Fail-closed rules

- Exact model/config/credential identity is probed again immediately before
  spawn and on every reconcile/cancel. Drift of `config_path`,
  `config_sha256`, `credential_source`, or `credential_sha256` fails closed
  with `dsh_identity_drift` (or `dsh_identity_unavailable`); at launch this
  happens before the spawn intent begins, so no half-dispatched lane can exist.
- Task/session correlation is checked per field on every poll/event/cancel
  receipt (`run_id`, `assignment_id`, `lane_index`, `base_sha`,
  `child_envelope_digest`, `model`, `session_ref`). Mismatch fails closed with
  `dsh_correlation_mismatch`.
- Forged or malformed receipts (unknown states/kinds/outcomes, out-of-bound
  integers, accessor properties, Proxies, sparse arrays, extra keys, own
  undefined) fail closed with typed codes and leave the lane untouched.
  Genuine probe loss degrades honestly instead: preflight blocks, reconcile
  reports uncertainty, cancellation stays `dsh_cancel_unresolved` and may be
  requested again because a cancellation is a control signal, not a prompt.

## Bounds and telemetry hygiene

`DSH_MAX_LANES=64`, `DSH_MAX_LANE_OPERATIONS=256`,
`DSH_MAX_LAUNCH_ATTEMPTS=2`, `DSH_MAX_RECORDED_EVENTS=1024`,
`DSH_MAX_EVENT_PAGE_RECORDS=64`, `DSH_MAX_EVENT_RECORD_BYTES=4096`,
`DSH_MAX_CURSOR=1e9`, session refs ≤128 bytes, clock readings within
`[0, 2100-01-01T00:00:00Z)` and monotonic per lane. Detail messages are
composed only from closed vocabulary words and validated integers (counts,
cursors, booleans, enumerated states); provider prompt, reply, question, or
event text can never reach a result, a detail pair, or an error message.

## Coverage and non-claims

Coverage lives in `test/r1-dsh-acpx-driver.test.mjs` (conformance, including
the unmodified P17 neutral contract suite) and
`test/r1-dsh-acpx-driver-adversarial.test.mjs` (hostile inputs, forged
receipts, bounds abuse, replay/substitution hostilities).

This slice does NOT qualify a real transport. The module claims no durable
P19/P21 store, scheduler, registry cutover, or supervisor cutover, and holds
no merge/PR authority.

## Surface for later real DSH Muse/Ox ACPX lifecycle conformance

A real-transport qualification harness must supply a production port that:

1. resolves the exact config file and credential per model (env first, then the
   owner-only file), returning their sha256 digests and never the secret bytes;
2. spawns `acpx exec --file -` with JSON output and the exact envelope on
   stdin, returning a stable bounded `session_ref`;
3. correlates JSON-RPC responses and session updates, projecting only bounded
   received output into the closed evidence/page/cancel receipts above;
   outgoing prompt frames must never become receipt content;
4. performs tree-scoped cancellation and reports `confirmed` only after the
   process group is observed stopped;
5. keeps every receipt free of provider-authored content beyond the closed
   vocabulary, since the driver will deny anything else.
