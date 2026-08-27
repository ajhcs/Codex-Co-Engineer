# Bounded sanitized artifact reader (P10)

Additive v3 contract over the accepted P08 artifact store. The reader is
the model-facing way to fetch a **bounded range** of an already-published
**sanitized** `ArtifactRefV1`. It does not sanitize, does not read raw
evidence, and does not change publish/verify/audit.

## Entry

```js
readSanitizedArtifactV1(store, artifactRef, options?)
```

- `store` is a handle from `openArtifactStoreV1`.
- `artifactRef` is an exact ten-key sanitized `ArtifactRefV1`. Raw class is
  denied before any artifact I/O.
- `options` is omitted, or a direct JSON object with only:
  - `offset` — intrinsic safe integer in `0..262144` (default `0`)
  - `max_bytes` — intrinsic safe integer in `0..8192` (default `8192`)

Proxies, accessors, symbol keys, exotic prototypes, and unknown keys fail
closed with the same typed vocabulary as P07/P08.

## Caps

| Cap | Value | Role |
| --- | ---: | --- |
| Range | 8192 bytes | Maximum selected artifact bytes retained from the stream |
| Wire | 12288 bytes | Maximum `JSON.stringify` size of one reader page |
| Sanitized class | 262144 bytes | Stored artifact size (P07); the reader never returns this whole |

The store hashes the **entire** artifact in 128 KiB chunks and copies only
the requested window into an 8192-byte-or-smaller buffer. A whole-file
buffer is never allocated. If the serialized page would exceed the wire
cap, the selected window is shortened until it fits.

## Page

Successful results are deep-frozen, detached, and JSON-safe. Selected
bytes are always `selected_encoding: "base64"` so a range that splits a
UTF-8 sequence stays well-formed JSON.

Clipping vs truncation:

- `reader_clipped` is `true` only when the reader/wire caps returned fewer
  bytes than `min(max_bytes, remaining sanitized bytes)`.
- `more` / `next_offset` describe paging through the **sanitized** artifact.
- `upstream_truncated`, `complete`, `source_byte_length`,
  `redaction_count`, and `sanitizer_version` are **unknown** until P09
  provenance exists. They are emitted as `null`, never as `false` or `0`.

## Fail-closed I/O

One serialized store operation:

1. Reopen the private root without following links and structurally audit.
2. No-follow open the regular single-link content file and its sidecar.
3. Require the sidecar snapshot to equal the requested sanitized ref.
4. Hash every byte, retain only `[offset, offset+take)`, and re-stat.
5. Deny digest/length mismatches, same-size tampers, sidecars that
   disagree with the ref, symlinks, hardlinks, FIFOs/devices, torn
   publications, and mid-read identity changes.

Errors are `RunContractV1Error` values with stable codes. They never echo
artifact bytes, the store root, a derived path, or an OS error string.

## Non-goals

P09 sanitization, ArtifactRef schema changes, MCP registration, provider
sinks, cleanup, supervisor/server wiring, and P11/P12 remain unclaimed.
