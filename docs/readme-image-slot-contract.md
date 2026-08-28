# README final-art slot contract

Status: frozen information architecture for the Codex-Co-Engineer 3.4.0
README, with safe final-art slots mapped to stable public files. Held
slots stay empty until a truthful source exists.

This contract lets published README art stay honest after copy and
placement froze. Retained scaffolding under `docs/assets/co-engineer-3.4.0/`
(`poster.jpg`, `poster.svg`, `mark.svg`, `hero-muted.mp4`, `hero-muted.webm`,
and `frame-poster.jpg`) remains provenance evidence. It is not the
published 3.4.0 README image set.

Published files live under `docs/assets/co-engineer-3.4.0/final/` with
equivalent plugin-package files under
`plugins/codex-co-engineer/assets/experience/final/`. Inventory must list
only files that will actually ship. Conceptual illustrations must not be
called exact host screenshots. Do not fabricate final screenshots.

## Stable README information architecture

The root README order is frozen as follows:

1. Hero: product promise, honest launch shape, host-specific UI disclaimer.
2. Visual demo: static fallback first, optional muted animation second.
3. First 60 seconds: first delegation, one assignment, several assignments,
   and the single provider/profile question.
4. How a run works: one submission, one coordinated wait, one verified
   decision, with failure and unresolved outcomes kept truthful.
5. Provider choices: Grok, Cursor Local/Cloud, and Muse in public language.
6. Codex authority and safety: trust boundary, worktree isolation, credentials,
   provider visibility, evidence ownership, and merge authority.
7. Chatting, grouped attention, and the final decision.
8. Install and authentication.
9. Migration from 3.2.1.
10. Troubleshooting.
11. Advanced Co-Engineer Control/API.
12. License.

Headings may receive typo fixes, but moving or renaming these sections after
art production begins requires an explicit slot-contract revision.

## Slot status and stable paths

Docs paths are README/GitHub public files. Plugin paths are packaged
equivalents. `manifest.json` is the publishability record for final-art
files; README may treat a referenced final-art file as published only when
that record does not mark it unpublishable.

| Slot ID | Status | Docs path | Plugin path |
| --- | --- | --- | --- |
| `hero-demo` | published static; optional silent motion linked, never autoplayed | `docs/assets/co-engineer-3.4.0/final/derived/hero-demo.jpg` with poster `docs/assets/co-engineer-3.4.0/final/derived/hero-frame-poster.jpg` and silent `docs/assets/co-engineer-3.4.0/final/derived/hero-muted.mp4` plus `docs/assets/co-engineer-3.4.0/final/derived/hero-muted.webm` | `plugins/codex-co-engineer/assets/experience/final/derived/hero-demo.jpg` with poster `plugins/codex-co-engineer/assets/experience/final/derived/hero-frame-poster.jpg` and silent `plugins/codex-co-engineer/assets/experience/final/derived/hero-muted.mp4` plus `plugins/codex-co-engineer/assets/experience/final/derived/hero-muted.webm` |
| `first-delegation` | published conceptual illustration | `docs/assets/co-engineer-3.4.0/final/derived/first-delegation.jpg` | `plugins/codex-co-engineer/assets/experience/final/derived/first-delegation.jpg` |
| `multi-lane-run` | held; static is malformed and supplemental motion uses unsupported hierarchy, so both are `publishable=false` | held evidence under `docs/assets/co-engineer-3.4.0/final/derived/multi-lane-run.held.jpg`, `multi-lane-frame-poster.held.jpg`, `multi-lane-muted.held.mp4`, and `multi-lane-muted.held.webm` | corresponding held evidence under `plugins/codex-co-engineer/assets/experience/final/derived/` |
| `provider-choices` | published conceptual illustration | `docs/assets/co-engineer-3.4.0/final/derived/provider-choices.jpg` | `plugins/codex-co-engineer/assets/experience/final/derived/provider-choices.jpg` |
| `grouped-attention` | held | none | none |
| `verified-final-decision` | held | none | none |
| `failure-unresolved` | published conceptual illustration | `docs/assets/co-engineer-3.4.0/final/derived/failure-unresolved.jpg` | `plugins/codex-co-engineer/assets/experience/final/derived/failure-unresolved.jpg` |
| `install-auth` | published conceptual illustration | `docs/assets/co-engineer-3.4.0/final/derived/install-auth.jpg` | `plugins/codex-co-engineer/assets/experience/final/derived/install-auth.jpg` |

Shipping plugin/marketplace inventory points only at files that will ship:

- logo: `plugins/codex-co-engineer/assets/experience/mark.svg`
- poster: `docs/assets/co-engineer-3.4.0/final/derived/hero-demo.jpg` and
  `./assets/experience/final/derived/hero-demo.jpg`
- hero MP4: `docs/assets/co-engineer-3.4.0/final/derived/hero-muted.mp4`
  and `./assets/experience/final/derived/hero-muted.mp4`
- hero WebM: `docs/assets/co-engineer-3.4.0/final/derived/hero-muted.webm`
  and `./assets/experience/final/derived/hero-muted.webm`

Do not inventory the malformed multi-lane static, held slots, or
unpublished supplemental motion.

## Final image slots

All exact host screenshots must come from the exact release candidate on the
shipping Codex host under qualification. Never fabricate an in-host state.
Crop out credentials, private paths, raw owner-only evidence, opaque
provider IDs, and unrelated repository content before approval. The mapped
3.4.0 stills below are conceptual illustrations unless a later contract
revision records an exact host capture.

| Slot ID | Purpose and exact placement | Aspect ratio | Preferred pixels | Light/dark behavior | Alt-text intent | Formats and size target | Exact state to depict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hero-demo` | Under `## Visual demo`, before any motion asset | 30:17 | 1920×1088 docs static and motion; 960×544 plugin motion | One neutral/system-aware static composition; JPEG is the GitHub-compatible fallback and frame poster format | “Give Codex a team of external co-engineers without giving up control.” | Static JPEG and frame poster ≤200 KiB; silent MP4/WebM ≤800 KiB docs and ≤400 KiB plugin | Co-Engineer identity and honest launch shape, with Codex shown as chief engineer—not a fake live run and not an exact host screenshot |
| `first-delegation` | After the verified result in `### Your first delegation` | 8:5 | 1600×1000 | One system-native conceptual composition; keep type legible on light or dark page chrome | First natural-language delegation and one verified candidate; mark the image conceptual | JPEG/PNG/WebP; ≤350 KiB | Fresh conversation, explicit Grok selection, exactly one assignment, one submission, final verified decision; conceptual, not an exact host screenshot |
| `multi-lane-run` | After the three-assignment example in `### Several independent assignments` | 8:5 for a future truthful capture | 1600×1000 if a corrected source later exists | Do not publish the malformed static or the unsupported-hierarchy motion | Three isolated assignments in one bounded Co-Engineer run, or an explicit hold | Current static and supplemental motion are retained evidence with `publishable=false`; neither is linked from README | Run card showing three independent lanes, provider/scope/state, base SHA, and Codex authority without raw evidence. Current sources do not satisfy this state |
| `provider-choices` | After the provider-specific example in `## Provider choices` | 8:5 | 1600×1000 | Must remain legible in both themes; avoid provider-color-only meaning | Explicit Grok, Cursor, and Muse assignment choices; mark the image conceptual | JPEG/PNG/WebP; ≤350 KiB | Explicit profile/model selection or the one grouped provider question; no learned/global routing claim; conceptual, not an exact host screenshot |
| `grouped-attention` | After the user’s one structured reply in the chatting section | 8:5 | 1600×1000 | Light and dark; visible keyboard focus; reduced-motion capture preferred | One grouped Co-Engineer decision with unaffected lanes continuing | PNG/WebP; ≤400 KiB each when a truthful source exists | Held. No supplied source shows grouped questions, affected and unaffected lanes, one structured response, and same-cursor resume together |
| `verified-final-decision` | Immediately after the verified-final sentence | 8:5 | 1600×1000 | Light and dark; status cannot rely on color alone | Final decision card with accepted, failed, and unresolved lanes | PNG/WebP; ≤400 KiB each when a truthful source exists | Held. Conceptual outcome art lacks branch/head/tree, scope, tests, reviews, candidate, and sanitized-evidence contract. No merge/push/rebase/PR controls |
| `failure-unresolved` | After the failure/unresolved paragraph | 8:5 | 1600×1000 | High-contrast failure state; no decorative motion | Required lane failed or remains unresolved, so no verified candidate is claimed; mark the image conceptual | JPEG/PNG/WebP; ≤350 KiB | Honest failed/unresolved result, explicit next action, unaffected evidence preserved, no false success. Conceptual illustration, not an exact host screenshot |
| `install-auth` | After the install command block | 8:5 | 1600×1000 | One theme is sufficient if terminal contrast is proven | Clean install and provider readiness without exposing credentials; mark the image conceptual | JPEG/PNG/WebP; ≤350 KiB | Fresh plugin install, new conversation, readiness check, and provider login status with all secrets and private paths absent. Conceptual, not an exact host screenshot |

## Motion and fallback contract

- Animation is optional and supplements `hero-demo`; it never replaces the
  static JPEG or the task-state illustrations.
- Allowed motion formats are muted MP4 and WebM. There is no autoplay audio.
  GitHub README Markdown cannot guarantee video playback or
  `prefers-reduced-motion` behavior, so keep the static hero authoritative
  and link optional silent animation explicitly. Do not embed an autoplaying
  player.
- Preferred animation dimensions are 1920×1088 for repository docs and
  960×544 for the packaged plugin. Target ≤800 KiB and ≤400 KiB respectively.
- Motion shows only truthful state changes, stops at terminal, and has a
  complete static path for reduced-motion and GitHub fallback.
- GitHub rendering may omit the video player. The static image and direct MP4
  or WebM links must tell the complete story without playback.
- Multi-lane supplemental motion is retained as held evidence and is not linked
  from README because the manifest records `publishable=false`.

## Approval and replacement rules

Safe 3.4.0 slots may use the mapped conceptual files above. Held slots stay
held until a source shows the required state. Final integration must keep
relative-link and package inventory tests, alt text, and current Gate X
evidence honest. The existing source videos and derived scaffolding remain
retained evidence even when final README art replaces them in public view.
Package and marketplace version stay `3.3.0`. The public catalog stays the
five tools `status`, `delegate`, `task`, `tasks`, and `cancel`.
