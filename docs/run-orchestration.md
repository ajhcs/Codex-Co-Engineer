# Run orchestration — dispatch boundary (P31)

The P31 run dispatch orchestration boundary is one additive v3 module,
`plugins/codex-co-engineer/mcp/v3/run-orchestration.mjs`. It binds accepted
P26 preflight to accepted P29 closed credential/environment projection
**before** any workspace, branch or ref, reservation, dispatch, credential
handoff, or provider process exists.

## Fail closed, then bind

A preflight failure — including CPU/RAM capacity denial — fails closed
with **zero side effects**. The boundary does not project credentials,
does not read credential files, does not create a handoff, does not
invoke the dispatcher, and does not create a workspace, branch, ref, or
reservation. Upstream P26 denial codes pass through unchanged.

Only a ready P26 receipt authorizes P29 projection. Projection is
in-memory and per resolved lane: Grok, Cursor Local, Cursor Cloud, DSH
Muse, and DSH Ox maps are closed allowlists. Foreign provider secrets,
Git/SSH/hosting tokens, control tokens, key-file paths, and
`NODE_OPTIONS` never appear. Lane argv never carries credential
material. Public receipts are content-free: they name projected keys and
identities, never values.

Prepare (`intent: "prepare"`, the default) still creates no handoff and
no provider process. Dispatch is an explicit later intent through an
injected seam. There is no hidden default dispatcher and no
supervisor/server cutover.

## Successful dispatch

When `intent` is `dispatch` and a dispatcher function is injected:

- every lane must already carry an exact provider/model pair
  (`orchestration_selection_unresolved` otherwise, with no handoff);
- owner-only P29 handoff files are created from the process identity;
- the dispatcher receives the closed env and credential-free argv;
- secrets never appear in argv;
- worker remote mutation stays denied (`denyRunRemoteMutationV1` /
  P29 `denyWorkerRemoteMutation`).

Cleanup unlinks remaining handoff files and stops injected children on
dispatch failure, cancel, terminal completion, and restart. A restart
creates a new handoff for the same identity after the previous file is
gone. This boundary still never creates a workspace, branch, ref, or
reservation.

## Composition

| Surface | Owner | Use here |
| --- | --- | --- |
| Launch-side validation | P26 `validateRunPreflightV1` | runs first; failures are zero-effect |
| Closed env / handoff / redaction | P29 `credential-boundary` | projection, isolation, cleanup, argv/env inspection |
| Remote mutation denial | P29 consulting P28 | `denyRunRemoteMutationV1` |
| Provider composition | P23 registry | not invoked |
| Live protected-ref audit | P30 | not invoked |

## Non-goals

No workspace provisioning, branch/ref creation, reservation, P30 live-ref
audit, public API, supervisor/server cutover, release, Gate A, merge,
rebase, push, PR, tag, or protected/default-ref authority. The separate
supervisor false-success reliability issue is out of scope.

## API

- `orchestrateRunDispatchV1(request, options?)` — async; request is
  `{ manifest, intent? }` with `intent` `prepare` (default) or `dispatch`.
  Options may inject `host` and `spawn` (P26), `env` (P29 source, unread
  until preflight succeeds), and `dispatch` (required for dispatch
  intent). Returns a detached frozen receipt or throws a typed
  content-free `RunContractV1Error` / `CredentialBoundaryError`.
- `cancelRunDispatchV1(receipt)` / `completeRunDispatchV1(receipt)` /
  `restartRunDispatchV1(receipt, options?)` — cleanup and restart.
- `denyRunRemoteMutationV1(operation)` — P29 worker remote-mutation denial.
- `describeRunOrchestrationV1()` — deterministic frozen inventory.

## Testing

```
node --no-warnings --test test/r1-run-orchestration.test.mjs \
  test/r1-run-orchestration-adversarial.test.mjs
```
