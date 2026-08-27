# Cursor Local driver (P19)

- Status: reconstructed against the accepted P17 driver contract
  (`ProviderDriverV1`, ADR 0001 identifiers `exact_identities`,
  `no_post_dispatch_fallback_or_replay`, `bounded_evidence`,
  `gate_a_no_duplicate_dispatch`,
  `gate_a_decision_or_attention_no_silent_unanswerable`).
- Scope: additive only. No existing module, surface, receipt, or legacy
  3.2.1 single-task behavior changed.
- Qualification: offline only. Nothing here runs a live Cursor Local CLI,
  network, cloud service, or repository egress.

## What ships

`plugins/codex-co-engineer/mcp/v3/cursor-local-driver.mjs` exposes:

- `createCursorLocalDriverV1(options)` — binds an injected local session
  transport to the four-operation `ProviderDriverV1` lifecycle and returns
  `{ schema, version, provider, declaration, driver, controls }`. `driver`
  is bindable with the P17 `bindProviderDriverV1(driver, declaration)`.
- `describeCursorLocalDriverV1()` — a frozen description of the closed
  surface. It claims no transports of its own (`transports: []`), no
  relaunch operations, no direct mode (`direct_mode: []`), no durable
  store, and exactly the managed local worktree / `run_base_sha`
  workspace posture.
- Closed constants for option keys, transport methods, control schemas,
  bounds, vocabularies, and the redaction marker.

The transport is a seam of six plain concrete functions — `availability`,
`spawn`, `send`, `observe`, `cancel`, `reply` — supplied by the host. The
driver owns none of them, spawns nothing itself, and performs no I/O.

## Exact binding

Every operation request must carry the exact compiled ChildEnvelopeV1 text
plus its raw lowercase 64-hex digest (digest-only launches are denied by
the P17 validators this module calls). On top of that proof the driver
requires, per lane:

- `execution.provider` equal to `cursor-local` — unresolved (`-`) slots and
  every other provider are refused;
- `execution.model` present and equal to the bound `model` option — omitted
  models are never derived, near-misses never substitute;
- `repository.base_sha` equal to the bound `run_base_sha` option — the run
  base never moves; managed local worktrees only;
- one lane identity per `(run_id, assignment_id)`; a different child
  envelope digest on the same lane is refused as stale identity.

A lane binding digest (`provider-run-identity.v1`) is computed over the
full provenance tuple and echoed by every transport result; echoes are
compared constant-time. A result that fails to echo the exact binding, or
a different live session id, is rejected as `uncorrelated_session`.

## Lifecycle

- **preflight** asks the transport whether the local Cursor route is
  available. It never spawns and never sends. `blocked` carries the closed
  detail pair; blocked lanes refuse launch forever.
- **launch** spawns at most once and dispatches at most once, ever. The
  `dispatched` disposition requires the transport's authoritative
  acknowledgement. A spawn failure stays pre-spawn `not_sent`; only the
  explicit closed code `pre_write_failure` keeps a post-spawn failure in
  honest `not_sent`; every other send failure after a successful spawn is
  reported as `dispatch_uncertain`. There is no retry, resend, replay,
  merge, fallback, or relaunch surface anywhere in the module.
- **reconcile** observes the exact spawned session with `observe` or
  `restart_reattach` intent. Unsupported declared features fail closed.
  Statuses map to `in_progress`, `unresolved_attention`, and `terminal`;
  the terminal latch repeats identical receipts without contacting the
  transport again.
- **cancel** addresses the exact original session. `confirmed` latches the
  terminal state; `requested` keeps observing until the provider settles;
  a terminal lane answers `already_terminal` without a transport call.

## Same-session attention replies

`controls.submitAttentionReply(request)` answers an outstanding attention
question inside the same live session. The reply is attempt-once: the
one-shot budget is consumed before the transport is touched, so a lying or
throwing transport can never earn a second attempt. It is bound to the
exact session id, question id, and bounded answer text; mismatches are
refused without consuming the budget or reaching the transport. An
unsupported reply posture refuses explicitly (`reply_unsupported`) before
any lane or transport contact and never starts a new prompt instead. Note
that the accepted P05 capability bridge pins `cursor-local` to
`live_session_reply`, so contradictory declarations fail at construction.

## Bounded, redacted evidence

All host-visible text — progress lines, event chunks, question text, and
the terminal flush — flows through one persistent per-lane redaction window
and then through UTF-8 byte bounds (8 KiB per segment, 64 segments, 64 KiB
per lane; answers up to 16 KiB). The window holds back a bounded tail so a
Bearer, Basic, API-key/token assignment, `sk-`/`ghp_`/AKIA-shaped token,
credential, or long hex envelope-digest signature split across leaves,
chunks, events, or reconciliations recombines only inside the window and
is redacted there before any host-visible byte exists. Overflow sets
`truncated` and drops further input silently; bounding failures are never
errors. Sub-window tails become visible at the terminal latch flush.
Segments cut on multi-byte boundaries round trip as valid UTF-8.

`controls.readEvidence(request)` drains frozen segments with exact UTF-8
byte accounting; draining is stable and non-consuming.

## Content-free quarantine

Options, both control requests, and every transport result pass through
one content-free structural quarantine built from the accepted P05/P17
closures plus the P17 request/result validators: live and revoked Proxies,
accessors (getters/setters), symbols, non-enumerables, own `undefined`,
exotic prototypes, sparse arrays, cycles, aliases, unknown keys, and
oversized depth are all rejected without running any caller code — getters
and proxy traps never execute. Transport failures are classified through a
plain own-data-property read of a closed code vocabulary only; everything
else becomes honest post-spawn uncertainty. Every error surface —
preflight, spawn, dispatch, observe, cancel, reattach, reply, identity,
extra-key, validation — throws typed `RunContractV1Error`s whose codes,
paths, and messages carry fixed templates only: hostile names and values
never escape into anything host-visible.

## Non-goals

No direct-mode widening; no supervisor, registry, server, or durable-store
cutover; no scheduler; no protected-ref mutation; no merge authority; no
create-PR path; no provider transport compiled into the module; no live
Cursor Local qualification in this slice; no change to legacy 3.2.1
single-task behavior or public receipt compatibility.

## Testing

Offline coverage lives beside the module:

- `test/r1-cursor-local-driver.test.mjs` — lifecycle, identity echo,
  one-spawn/one-ack dispatch, reply attempt-once, cancel/reattach/latch,
  evidence bounds.
- `test/r1-cursor-local-driver-adversarial.test.mjs` — hostile inputs,
  substitution, replay, uncorrelated sessions, recombination, overflow,
  content-free error surfaces.
- `test/fixtures/r1-cursor-local-transport.mjs` — scripted transport stubs;
  no real CLI, network, or repository is touched.

Run from `plugins/codex-co-engineer`:

```
node --no-warnings --test test/r1-cursor-local-driver.test.mjs \
  test/r1-cursor-local-driver-adversarial.test.mjs
```
