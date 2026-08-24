# Future-harness capability and evidence requirements (P22)

P22 is an interface/template and a reusable conformance kit over the accepted
P17 `ProviderDriverV1` contract. It is not a fifth provider, not a supervisor
or registry cutover, and not a live transport. Future harnesses copy the
inert template, bind caller-supplied identities, and run the same kit.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/provider-driver-template.mjs`
- `plugins/codex-co-engineer/mcp/v3/future-harness.mjs`
- `plugins/codex-co-engineer/mcp/v3/provider-driver-conformance.mjs`
- `plugins/codex-co-engineer/test/fixtures/r1-future-harness-conformance.mjs`
- `plugins/codex-co-engineer/test/r1-future-harness.test.mjs`
- `plugins/codex-co-engineer/test/r1-future-harness-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/r1-future-harness-conformance.test.mjs`

## Required contract evidence

Every future harness must prove the closed P17 lifecycle, using P17
validators rather than a parallel schema:

- Exactly the four own operations `preflight`, `launch`, `reconcile`, and
  `cancel`. No `reply`, `retry`, `relaunch`, or merge/PR operation.
- The accepted P05 13-field capability record, including
  `never_replay` and `none_codex_only_integration`.
- Exact compiled `ChildEnvelopeV1` bytes plus the matching digest. Digest-only
  launches are denied.
- Frozen receipts that echo the proven `run_id`, `assignment_id`,
  `lane_index`, `base_sha`, and envelope digest.
- Preflight before spawn. A blocked preflight cannot launch. A possible send
  is never replayed onto this or another transport.

This evidence is contract evidence. It does not attest a live route.

## Supported-capability evidence

A declared-supported feature is evidence only when the harness actually
exercises it through P17:

- `cancellation: supported` — cancel after a real dispatch observation, with
  `cancel_requested` / `cancel_confirmed` / `already_terminal`.
- `restart: reconcile_reattach_only` — reattach the exact recorded identity.
  It is never a relaunch.
- `detailed_events` / `live_progress` — bounded include lists on reconcile
  only, never extra receipt keys.
- `same_session_reply: live_session_reply` — still not a fifth method.
  Attention remains `unresolved_attention` until a later supported reply
  path exists outside this kit.

The inert template does not claim these features. Its fail-closed feature
record is explicit and caller-supplied.

## Unsupported-operation closure

Unsupported means fail closed, not "try anyway":

- Defaults for the template are all-unsupported features and `not_sent`
  launch (no transport is configured).
- Cancel, restart reattach, live progress, and detailed events throw
  `unsupported_capability` when declared unsupported.
- Same-session reply `unsupported_unresolved_attention` must not invent a
  continuation.
- Merge, push, create-PR, fallback, replay, credentials, and direct-mode
  keys keep the P02 forbidden-class codes.
- Exact provider, model, workspace, run, request, branch, and base
  identities are caller-supplied, validated through P17, frozen, and never
  substituted.

## Real-transport qualification

Mocks never prove a live route.

| Evidence class | What it may prove | What it must not claim |
| --- | --- | --- |
| Required contract | P17 surface, identity echo, no replay | Any provider is reachable |
| Supported capability | Declared feature behaves as declared | The feature works on a real host |
| Unsupported closure | Honest denial, no fallback | A missing feature is implemented |
| Real-transport qualification | Live spawn, events, cancel, reattach, terminal | — this kit does not produce it |

`runFutureHarnessConformanceKitV1` always returns
`live_transport_qualification: false`. Passing the kit, the inert template,
or a scripted double is mock/conformance evidence only. Grok, Cursor Local,
Cursor Cloud, and DSH live qualification remain later, separate lanes after
those adapters are accepted.

The template launches no process, opens no network, reads no clock or random
source, and stores no credentials. Future harnesses that add a transport must
inject that transport and qualify it with real-route evidence outside P22.
