# Local provider result sink (P11)

Additive v3 contract over the accepted P09 sanitizer, P08 store, and P10
sanitized reader. It routes **final** local Grok ACP, Cursor Local ACP, and
DSH ACPX/CLI provider output into raw+sanitized artifact storage through
one provider-neutral sink. It does not replace 3.2.1
`task.result` / `result_*` bounding.

## Entry

```js
sinkLocalProviderResultV1(store, options)
```

- `store` is a handle from `openArtifactStoreV1` (or
  `openLocalProviderArtifactStoreV1` under a state root).
- `options` is a direct JSON object with only:
  - `run_id`, `assignment_id`, `provider`, `model` — exact identity
  - `child_envelope_digest` — optional lowercase 64-hex digest
  - `source` — string, JSON value, intrinsic Buffer/Uint8Array, or async
    iterable of string/byte chunks
  - `source_truncated` — optional exact boolean
  - `media_type` — optional identity-encoded text media type

Local providers only: `grok`, `cursor-local`, `dsh`. Cursor Cloud is
denied. Identities are never guessed from `task.id`. The ArtifactRef
relative path is
`runs/{run_id}/{assignment_id}/{provider}/{identity_binding}/provider-report.{ext}`,
where `identity_binding` is the SHA-256 of length-prefixed provider,
model, and optional child-envelope digest, so two identities cannot
share a path or ref.

## Publication

The sink snapshots the complete transport-available source up to the
existing raw class cap (32 MiB) and publishes through
`sanitizeAndPublishArtifactV1`. Older output is never silently dropped.
Crossing a class cap fails closed rather than clipping toward the cap. If
the upstream/transport was already clipped, available bytes are stored and
`source_truncated` / `complete` are recorded truthfully.

Empty sources are not published and do not invent an artifact. A
publication that does not verify is not reported.

Only sanitized artifacts are model-readable. The return is detached
deep-frozen content-free metadata: raw/sanitized `ArtifactRefV1` values,
P09 provenance, digests, redaction counts, truncation, and the inline
tail. Never raw bytes, secrets, prompt text, store roots, or live handles.

## Inline tail

After verify, the sink reads the sanitized artifact through
`readSanitizedArtifactV1` and retains at most 4,096 UTF-8 bytes from the
end, aligned on a valid UTF-8 boundary.

- `inline_clipped` is true when the inline window is shorter than the
  sanitized artifact.
- `source_truncated` / `complete` are the P09 provenance facts, never
  inferred from the tail length.
- `reader_clipped` is the P10 range/wire fact.

No secret may appear in the tail: split-token and chunk-boundary redaction
remain P09's.

## Worker seam

`acp-worker.mjs` is the only serialized integration. It publishes the
legacy bounded `task.result` first, then attaches optional
`provider_result_sink` metadata. Sink failure after provider terminal is
typed content-free evidence with a closed code/path and a generic
bounded message; it does not invent completion, change provider status,
or replay work. Tasks without exact run/child/model identity keep the
3.2.1 path unchanged.

Failed, cancelled, or other non-success ACP turns never publish
accumulated partial text as complete. Collector overflow at the raw
class cap is handled inside `attachLocalProviderResultSink` with typed
content-free nonpublication evidence and does not rewrite the provider
terminal.

Provider completion remains evidence, never acceptance.

## Non-goals

P13 evidence bundles, supervisor/server MCP registration, P18/P20
transports, cleanup, scheduler, and protected refs remain unclaimed.
P12 Cursor Cloud result-source materialization is a separate module. This module does not edit `task-store.mjs`. Ambient
umask variance for P08 store-root fixtures is recorded in
[future-work.md](future-work.md); P11 fixtures chmod `0700` after
creation and do not change process umask.
