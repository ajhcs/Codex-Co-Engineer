# MCP Apps UI (UI-02)

Give Codex a team of external co-engineers without giving up control.

This slice extends accepted UI-01. It keeps the display-only **run** and
**final decision** cards, then adds the grouped-attention card plus the
accessibility and reduced-motion contract. It consumes the accepted UX-04
experience projection and nested `_meta.ui.resourceUri` metadata. It does
not redesign those projections, add a sixth tool, or replace structured or
text fallbacks.

Host support is host-specific/unproven until QA-01.

## Honest claim

up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Do not claim credit reduction, 8x speed, universal UI, or SOTA routing.

## What this slice shows

Inline run card:

- objective
- repository digest and base SHA
- each lane's provider, write scope, and state
- efficiency inline without routine wake: provider, branch, head, health, and pending IDs (bounded)
- explicit Codex authority: Codex remains chief engineer, reviewer, and merge authority

Grouped attention card:

- every current question, grouped once per assignment lane
- affected assignments that need this one decision
- unaffected assignments that keep working
- unsupported same-session providers as explicit unresolved assignments
- exactly one bounded structured reply on the public `task` tool via `run_reply`
- the reply bound to the exact run, session, attention batch, and event cursor
- same-cursor resume only when `cursor_resume` is true and the batch and every
  answerable question share one identical nonempty event cursor, with no
  question-cursor fallback
- resume of that same cursor without replay

Final decision card (Codex-native PR-ready):

- owned branch, head, tree, base, and target (truthfully displayed from supplied identity, validated, bounded)
- changed summary, clean state (unknown when absent), verification/blockers (truthful, bounded)
- push / draft PR / current PR head (Not available when absent; Current PR Head is SHA-40 or Not available)
- ready_for_sol_merge only from typed boolean true with evidence present and candidate composed, otherwise no (never from strings or numbers)
- UsageLedger-compatible compact summary or unknown (bounded, redacted; no fabricated facts)
- bounded safe evidence refs (only known evidence kinds, max 16)
- the verified-final sentence only when UX-04 already allows it
- accepted, failed, and unresolved lanes; scope, tests, reviews, candidate, and evidence

The cards never expose merge, push, rebase, create-PR, tag, or release
controls. Rendering or reading them must not dispatch, wait, cleanup, merge,
push, rebase, tag, release, mutate a ref, or mutate a remote. The one
user-authorized grouped reply is the only permitted interaction and must not
create extra model-visible calls beyond that required `task` `run_reply`.

## Grouped reply contract

The attention card sends at most one standards-compatible Apps host-bridge
`tools/call`:

- tool: `task`
- arguments: `{ run_id, run_reply }`
- `run_reply` uses the accepted run-adapter reply identity: `batch_id`,
  `expected_revision`, and one round of answers bound to assignment, question,
  session, and task ids

It fails closed on a stale, missing, or mismatched cursor, missing
`cursor_resume`, run, batch, question, lane, revision, or delivery
authority. Duplicate assignment answers are rejected. Nested `run_reply`
and answer objects are closed-schema checked before the host send. The
`tools/call` JSON-RPC id is the non-null canonical delivery identity for
that cursor; forged, null, or drifted ids fail. A second click, a second
submit, a reconnect, or a fresh session replay must not send a second
reply. Unsupported Cursor Cloud and Muse same-session replies stay visible
as unresolved lanes; they are not skipped and they do not start another
session.

## Headless fallback

Clients that omit a compatible MCP Apps plus resources capability see no UI
metadata, no `ui://` resource, and no failure. The five public tools stay:

`status`, `delegate`, `task`, `tasks`, `cancel`

Omitted `response_mode` keeps the 3.2.1 full sanitized receipt in
`content[0].text`. Structured text fallback remains a bounded summary over
authoritative `structuredContent`. Missing, forged, or malformed Apps
capability is silent.

## Feature detection

Register, list, and read UI resources only when the client advertises both:

1. the MCP Apps extension `io.modelcontextprotocol/ui` with MIME
   `text/html;profile=mcp-app`
2. a resources capability object

UX-04 still requires a registered `ui://` resource before nested
`_meta.ui.resourceUri` is emitted. This slice registers:

| Card | Resource | Interaction |
| --- | --- | --- |
| run | `ui://codex-co-engineer/experience/run` | display-only |
| attention | `ui://codex-co-engineer/experience/attention` | one grouped reply |
| final | `ui://codex-co-engineer/experience/final` | display-only |

The shell URI remains unregistered. Real-host rendering, keyboard, and
assistive-technology qualification remain QA-01.

Malformed or unknown URIs do not get registered. A compatible client that
reads an unknown URI receives resource-not-found. An unsupported client
receives method-not-found for `resources/list` and `resources/read` without
a process failure.

## Display-only host protocol

The HTML documents are complete MCP Apps resources
(`text/html;profile=mcp-app`). They may complete a host `ui/initialize`
handshake with empty app capabilities. Run and final cards never send
`tools/call` or any other model-visible method. The attention card may send
only the one authorized `task` `run_reply`. Owner-only keys, credentials,
and raw evidence payloads are stripped before paint. User strings are
rendered as text.

## Accessibility and motion

All three cards provide:

- semantic landmarks, headings, lists, and labels
- keyboard-only completion of the grouped reply
- deterministic focus management and a visible `:focus-visible` outline
- truthful live-region updates, never fake progress
- no color-only meaning
- system fonts and an accessible contrast scale: `#111111` / `#374151` /
  `#4B5563` / `#6B7280` on light, inverted on dark, plus `Canvas` /
  `CanvasText` fallbacks
- locale, direction, theme, and safe-area support
- bounded zoom and reflow
- no owner-only evidence

Motion is only for a truthful one-shot state change, stops at the terminal
submitted or denied state, and is disabled under `prefers-reduced-motion`.
There is no decorative background animation.

## Owned files

- `plugins/codex-co-engineer/mcp/v3/experience-ui-resource.mjs`
- `plugins/codex-co-engineer/mcp/v3/ui/**` (`final.html`, `run.html`, `display-only.js`, `foundation.css`)
- `plugins/codex-co-engineer/mcp/v3/server.mjs` (capability-gated list/read/meta only; UI-01 wiring preserved)
- `plugins/codex-co-engineer/test/r1-experience-ui.test.mjs`
- `plugins/codex-co-engineer/test/r1-experience-ui-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-ui/**`
- this document

Path ceiling: `experience-ui-resource.mjs`; `ui/final.html, run.html, display-only.js, foundation.css`; `r1-experience-ui` tests/adversarial/fixtures; `docs/mcp-apps-ui.md`.

## Non-goals

This slice does not implement a shell app, a sixth tool, merge/push/PR
controls, README/skill/manifest/version changes, unlimited persistent chat,
or a claim that every MCP host will render the cards. It does not run Git
actions or fabricate facts. Real-host support stays unproven until QA-01.

## Testing

```
node --no-warnings --test test/r1-experience-ui.test.mjs
node --no-warnings --test test/r1-experience-ui-adversarial.test.mjs
node --no-warnings --test test/r1-experience-response.test.mjs test/r1-experience-response-adversarial.test.mjs
node --no-warnings --test test/v3-server.test.mjs test/v3-response.test.mjs
```
