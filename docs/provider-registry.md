# Provider registry — closed composition authority (P23)

The P23 provider registry is one additive v3 module,
`plugins/codex-co-engineer/mcp/v3/provider-registry.mjs`. It is the
deterministic, closed composition authority behind provider selection: the
one place where the accepted `ProviderDriverV1` adapters are registered and
composed. It owns only that seam.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/provider-registry.mjs`
- `plugins/codex-co-engineer/test/r1-provider-registry.test.mjs`
- `plugins/codex-co-engineer/test/r1-provider-registry-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/r1-provider-registry-integration.test.mjs`

## Registered surfaces

Exactly four provider slots exist, in the frozen P02 grammar order
(`grok`, `cursor-local`, `cursor-cloud`, `dsh`). The slot vocabulary is
re-derived on every read from the accepted P02 grammar leaf
(`knownProvidersList()`), so the registry cannot drift from the closed
provider set:

| Slot | Accepted adapter | Composition seam |
| --- | --- | --- |
| `grok` | P18 `grok-acp-driver.mjs` | `bindGrokAcpDriverV1` (transport property) |
| `cursor-local` | P19 `cursor-local-driver.mjs` | `createCursorLocalDriverV1` (options bag) |
| `cursor-cloud` | P21 `cursor-cloud-driver.mjs` | `bindCursorCloudDriverV1` (transport property) |
| `dsh` | P20 `dsh-acpx-driver.mjs` | `createDshApxDriverV1` (options bag) |

The P22 future-harness template and conformance kit
(`provider-driver-template.mjs`, `future-harness.mjs`,
`provider-driver-conformance.mjs`) are inventoried as
mock/conformance evidence with `provider_slot: null`. They are never a
fifth provider, never selectable, and never composable through this
surface; passing the kit still proves no live transport.

## Closed invariants

- **Closed vocabulary.** Four slots, fixed at module load, frozen, and
  re-derived from the P02 grammar. Runtime growth is impossible.
- **Deterministic selection.** `resolveRegistrySelectionV1` maps an exact
  `{provider, model}` pair onto exactly one entry with rule
  `exact_closed_slot_no_fallback`: no preference walk, no substitution, no
  fallback, no retry, and no replay. Where the accepted adapter owns a
  closed model list (`dsh`), selection enforces membership against that
  accepted frozen constant; where an adapter owns a model grammar, the
  adapter stays the sole model authority. No vocabulary is widened.
- **One factory per slot.** `registryComposeFunctionV1(slot)` returns the
  exact accepted factory object; `composeProviderDriverV1(slot, options)`
  delegates to it after a content-free quarantine and returns its value
  untouched. There is no wrapper layer, so adapter lane stores, evidence
  maps, and identity binding keep their accepted semantics.
- **No ambient discovery.** The module performs no filesystem, environment,
  PATH, network, clock, random-source, process, or dynamic-import access at
  load or call time. Registration is static imports of accepted modules.
- **Content-free failure.** Hostile providers, selections, and options —
  live or revoked Proxies, accessors, symbols, non-enumerable properties,
  exotic prototypes, unknown keys — fail closed with typed
  `RunContractV1Error`s whose codes, paths, and messages are fixed
  templates. Provider gating happens before any option byte is read, and
  getters and proxy traps never execute.
- **Accepted claims are quoted, not restated.** Inventory data is projected
  from each accepted module's own exported describe surface into detached
  frozen clones, so no parallel capability schema exists.

## Non-goals

No supervisor, server, scheduler, or durable-store cutover; no live
transport qualification for any provider; no merge/PR authority; no direct
mode; no ambient discovery; no fallback, replay, retry, or fifth operation;
no version change (3.2.1 legacy receipts and behavior are untouched). The
supervisor/run-runtime cutover onto this registry remains later work under
`docs/future-work.md`.

## API

- `describeProviderRegistryV1()` — deterministic deep-frozen inventory:
  schema/version, slots, per-slot entries (adapter schema id, compose
  function name, option contract, model rule, accepted adapter surface),
  the P22 evidence section, and explicit all-false nonclaims.
- `registrySlotsV1()` / `PROVIDER_REGISTRY_SLOTS` — fresh frozen /
  snapshot copies of the closed slot order.
- `isRegistrySlotV1(provider)` / `requireRegistrySlotV1(provider)` —
  boolean membership / typed exact-slot requirement.
- `registryEntryV1(provider)` — frozen inventory entry for one slot.
- `resolveRegistrySelectionV1({provider, model})` — pure deterministic
  selection plan; constructs nothing.
- `registryComposeFunctionV1(provider)` — the exact accepted factory.
- `composeProviderDriverV1(provider, options)` — quarantined composition
  through the accepted factory.

## Testing

```
node --no-warnings --test test/r1-provider-registry.test.mjs \
  test/r1-provider-registry-adversarial.test.mjs \
  test/r1-provider-registry-integration.test.mjs
```

From `plugins/codex-co-engineer`. The integration file composes every
accepted driver exclusively through the registry and drives preflight,
launch, reconcile, and cancel with exact identity echo.
