# 3.4.0 final-art provenance

Give Codex a team of external co-engineers without giving up control.

This is the owner record for the 3.4.0 final-art packaging slice. Plugin and
marketplace version stay `3.3.0`. Canonical per-file inventory, hashes, byte
sizes, dimensions, codecs, transformation argv, slots, and hold reasons live
in:

- `docs/assets/co-engineer-3.4.0/final/manifest.json`
- `plugins/codex-co-engineer/assets/experience/final/manifest.json`

Those two files are byte-identical. Originals are preserved under each owned
tree at `final/sources/` using the intake filenames. Shipping derivatives for
fit, encoding, silence, size, and accessibility live under `final/derived/`.
This slice does not replace the current README scaffolding poster or hero, and
it does not invent missing host states.

The honest product claim remains: up to eight isolated external co-engineers,
one bounded run, one coordinated wait, one verified decision.

## Intake (owner-oriented)

Intake paths are redacted. No credentials, API keys, or unrelated machine
roots are recorded in public prose.

| ID | Original filename | Redacted origin | SHA-256 | Bytes |
| --- | --- | --- | --- | --- |
| architecture-static | `856Qz.png` | `owner-intake/CheapTesting/856Qz.png` | `aad77a7e0c19919e6325c555ace274759bb81e0c7341487b998a76f05acaeb74` | 181725 |
| first-delegation-static | `grok-image-7845770e-036e-42aa-baf0-4fdf1737fe5d.jpg` | `owner-intake/CheapTesting/grok-image-7845770e-036e-42aa-baf0-4fdf1737fe5d.jpg` | `0aa5595d0d71438b14ded380857483e61dd807b25db9cda59b143c02faafc678` | 217921 |
| multi-lane-static-malformed | `grok-image-688b2e53-8327-4db7-8fca-017315787f0f.jpg` | `owner-intake/CheapTesting/grok-image-688b2e53-8327-4db7-8fca-017315787f0f.jpg` | `37bc5cd0382829799aea0b638b54636be1d8a575546aa16f9aa9809703d8e44f` | 260551 |
| provider-choices-static | `grok-image-9a20c1b8-8377-48d5-b85a-0000d1677bbb.jpg` | `owner-intake/CheapTesting/grok-image-9a20c1b8-8377-48d5-b85a-0000d1677bbb.jpg` | `7d523040163f376498f2e472101b1c7319d015990a36a1d6273957e1833d129e` | 232013 |
| conceptual-combined-outcome | `grok-image-0bf969e7-4d27-49d5-9887-6dfa7a93fb87.jpg` | `owner-intake/CheapTesting/grok-image-0bf969e7-4d27-49d5-9887-6dfa7a93fb87.jpg` | `046cddc8debe68c1b7ea1dbee0650bb472e16dfbb47703036b7f270bf06edec2` | 284446 |
| install-auth-static | `grok-image-a8a1cd99-2dad-434d-b622-522d395e4ace.jpg` | `owner-intake/CheapTesting/grok-image-a8a1cd99-2dad-434d-b622-522d395e4ace.jpg` | `88e2bae21b9417dea21f9ab224d68a040920e458a0c34995daf35ea5eea1f9fc` | 237868 |
| architecture-motion | `grok-video-8f9d1b07-38f2-4b3e-8116-cc5f928755ee.mp4` | `~/.codex/attachments/f69decc1-9912-4582-a096-8c1b0edd18c2/grok-video-8f9d1b07-38f2-4b3e-8116-cc5f928755ee.mp4` | `aebc54839ab39e5d402e2935af35ba829af4608f0f7d76f5adbe0560fd131117` | 1257222 |
| multi-lane-motion | `grok-video-a9b4de81-33fa-4f93-83e7-cee955480531.mp4` | `~/.codex/attachments/f69decc1-9912-4582-a096-8c1b0edd18c2/grok-video-a9b4de81-33fa-4f93-83e7-cee955480531.mp4` | `0ddffd0bd7478b645211fa3aa3707ec62f8777591f73ec5c32c5f0af4c9467e4` | 2986281 |

Source motion files are H.264 + AAC + MJPEG cover art. Shipping motion maps
only `0:v:0`, uses `-an`, strips metadata, and is proven with `ffprobe` to
have a single video stream and no audio.

## Safe public mapping

| Slot | Source | Shipping | Publishable |
| --- | --- | --- | --- |
| `hero-demo` | architecture still + silent architecture motion | `derived/hero-demo.jpg`, `hero-muted.mp4`, `hero-muted.webm`, `hero-frame-poster.jpg` | yes |
| `first-delegation` | first-delegation still | `derived/first-delegation.jpg` | yes |
| `provider-choices` | provider-choices still | `derived/provider-choices.jpg` | yes |
| `failure-unresolved` | conceptual combined outcome only | `derived/failure-unresolved.jpg` | yes |
| `install-auth` | install/auth still | `derived/install-auth.jpg` | yes |
| `multi-lane-run` | malformed static + inspected motion | `*.held.*` derivatives | no |
| `grouped-attention` | none supplied | none fabricated | no |
| `verified-final-decision` | none that shows required details | none relabeled | no |

Publishable stills and motion are conceptual illustrations, not exact Codex
host screenshots. Derivatives pad to the frozen slot aspect instead of
stretching or cropping meaning. Docs hero is 1920×1088; other docs stills are
1600×1000; plugin hero is 960×544; other plugin stills are 800×500.

## Holds

- **grouped-attention.** No supplied source depicts grouped questions,
  affected/unaffected lanes, one structured reply, or a resumed cursor.
- **verified-final-decision.** The conceptual combined-outcome art does not
  show branch, head, tree, scope, tests, reviews, candidate, or sanitized
  evidence. It is used only for `failure-unresolved`.
- **multi-lane-run static.** Preserved, `publishable=false`, because it
  contains the malformed phrase `Changes return ition`.
- **multi-lane-run motion.** Packaged as silent supplemental after frame
  inspection. Frames do not inherit `Changes return ition`, but they use
  unsupported Main task / Sub-task hierarchy rather than independent
  assignments on a run card, so `publishable=false`.

## Budgets and tools

Frozen README/package ceilings used here: docs hero still ≤200000 bytes, docs
motion ≤800000, other docs stills ≤350 KiB, plugin hero still ≤80000, plugin
hero MP4 ≤200000, plugin WebM ≤400000. Exact per-file ceilings are in the
manifest.

Re-derive with `python3 docs/assets/co-engineer-3.4.0/final/package-final-art.py`
(add `--force-encode` to rebuild binaries). Tooling: ffmpeg/ffprobe 6.1.1,
libvpx VP9 v1.14.0, libx264 `preset slow` / CRF search, VP9 `deadline good`.
