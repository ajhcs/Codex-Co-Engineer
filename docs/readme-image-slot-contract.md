# README final-art slot contract

Status: frozen information architecture for the Codex-Co-Engineer 3.4.0
README. Final user-designed artwork is pending.

This contract lets final artwork begin only after README copy and placement
have stopped moving. The current poster, mark derivatives, and muted animation
are provenance-preserved scaffolding and reference assets. They are not the
user-approved final README image set and must not be described as such.

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

## Final image slots

All screenshots must come from the exact release candidate on the shipping
Codex host under qualification. Never fabricate an in-host state. Crop out
credentials, private paths, raw owner-only evidence, opaque provider IDs, and
unrelated repository content before approval.

| Slot ID | Purpose and exact placement | Aspect ratio | Preferred pixels | Light/dark behavior | Alt-text intent | Formats and size target | Exact state to depict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hero-demo` | Under `## Visual demo`, before any motion asset | 30:17 | 1920×1088 | One neutral/system-aware static composition; a separate dark variant only if the final art genuinely changes | “Give Codex a team of external co-engineers without giving up control.” | Static WebP or JPEG; optional SVG only when text remains accessible; ≤200 KiB | Co-Engineer identity and honest launch shape, with Codex shown as chief engineer—not a fake live run |
| `first-delegation` | After the verified result in `### Your first delegation` | 8:5 | 1600×1000 | Matched light and dark captures, or one system-native capture identified by theme | First natural-language delegation and one verified candidate | PNG/WebP; ≤350 KiB each | Fresh conversation, explicit Grok selection, exactly one assignment, one submission, final verified decision |
| `multi-lane-run` | After the three-assignment example in `### Several independent assignments` | 8:5 | 1600×1000 | Same treatment as `first-delegation` | Three isolated assignments in one bounded Co-Engineer run | PNG/WebP; ≤350 KiB each | Run card showing three independent lanes, provider/scope/state, base SHA, and Codex authority without raw evidence |
| `provider-choices` | After the provider-specific example in `## Provider choices` | 8:5 | 1600×1000 | Must remain legible in both themes; avoid provider-color-only meaning | Explicit Grok, Cursor, and Muse assignment choices | PNG/WebP; ≤350 KiB | Explicit profile/model selection or the one grouped provider question; no learned/global routing claim |
| `grouped-attention` | After the user’s one structured reply in the chatting section | 8:5 | 1600×1000 | Light and dark; visible keyboard focus; reduced-motion capture preferred | One grouped Co-Engineer decision with unaffected lanes continuing | PNG/WebP; ≤400 KiB | All current questions grouped once, affected/unaffected lanes identified, one structured reply, same cursor resumed |
| `verified-final-decision` | Immediately after the verified-final sentence | 8:5 | 1600×1000 | Light and dark; status cannot rely on color alone | Final decision card with accepted, failed, and unresolved lanes | PNG/WebP; ≤400 KiB | Branch/head/tree, scope, tests, reviews, candidate, and sanitized evidence; no merge/push/rebase/PR controls |
| `failure-unresolved` | After the failure/unresolved paragraph | 8:5 | 1600×1000 | High-contrast failure state; no decorative motion | Required lane failed or remains unresolved, so no verified candidate is claimed | PNG/WebP; ≤350 KiB | Honest failed/unresolved result, explicit next action, unaffected evidence preserved, no false success |
| `install-auth` | After the install command block | 8:5 | 1600×1000 | One theme is sufficient if terminal contrast is proven | Clean install and provider readiness without exposing credentials | PNG/WebP; ≤350 KiB | Fresh plugin install, new conversation, readiness check, and provider login status with all secrets and private paths absent |

## Motion and fallback contract

- Animation is optional and supplements `hero-demo`; it never replaces the
  static poster or the task-state screenshots.
- Allowed motion formats are muted MP4 and WebM, with controls, no autoplay
  audio, a static poster, and a direct-file fallback.
- Preferred animation dimensions are 1920×1088 for repository docs and
  960×544 for the packaged plugin. Target ≤800 KiB and ≤400 KiB respectively.
- Motion shows only truthful state changes, stops at terminal, and has a
  complete static path for `prefers-reduced-motion`.
- GitHub rendering may omit the video player. The static image and direct MP4
  or WebM links must tell the complete story without playback.

## Approval and replacement rules

The user supplies or approves the final image set after this copy checkpoint.
Final integration must update asset provenance, relative-link and package
inventory tests, dimensions, byte sizes, hashes, alt text, and current Gate X
screenshots. The existing source videos and derived scaffolding remain retained
evidence even when final README art replaces them.
