# MCP Apps UI (UI-01)

Give Codex a team of external co-engineers without giving up control.

This slice adds an optional, feature-detected MCP Apps HTML surface for the
inline **run** and **final decision** cards. It consumes the accepted UX-04
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
- explicit Codex authority: Codex remains chief engineer, reviewer, and merge authority

Final decision card:

- accepted, failed, and unresolved lanes
- branch, head, and tree
- scope, tests, reviews, candidate, and evidence
- the verified-final sentence only when UX-04 already allows it

The final card never exposes merge, push, rebase, create-PR, tag, or
release controls. The cards are display-only. Rendering or reading them
must not cause an extra model-visible call, dispatch, wait, reply,
cleanup, ref mutation, or remote mutation.

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
`_meta.ui.resourceUri` is emitted. This slice registers only:

| Card | Resource |
| --- | --- |
| run | `ui://codex-co-engineer/experience/run` |
| final | `ui://codex-co-engineer/experience/final` |

The shell and grouped-attention URIs remain unregistered. Attention
interaction is UI-02. Keyboard, focus, reduced-motion, and final
accessibility qualification are UI-02/QA-01. This slice supplies semantic
markup, system fonts, and brand colors as a noninteractive foundation:
`ui-sans-serif, system-ui, Helvetica, Arial, sans-serif` and the accepted
`#111111` / `#374151` / `#4B5563` / `#6B7280` scale. There is no fake
progress and no decorative animation.

Malformed or unknown URIs do not get registered. A compatible client that
reads an unknown URI receives resource-not-found. An unsupported client
receives method-not-found for `resources/list` and `resources/read` without
a process failure.

## Display-only host protocol

The HTML documents are complete MCP Apps resources
(`text/html;profile=mcp-app`). They may complete a host `ui/initialize`
handshake with empty app capabilities. They never send `tools/call` or any
other model-visible method. Owner-only keys, credentials, and raw evidence
payloads are stripped before paint. User strings are rendered as text.

## Owned files

- `plugins/codex-co-engineer/mcp/v3/experience-ui-resource.mjs`
- `plugins/codex-co-engineer/mcp/v3/ui/**`
- `plugins/codex-co-engineer/mcp/v3/server.mjs` (capability-gated list/read/meta only)
- `plugins/codex-co-engineer/test/r1-experience-ui.test.mjs`
- `plugins/codex-co-engineer/test/r1-experience-ui-adversarial.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-ui/**`
- this document

## Non-goals

This slice does not implement grouped-attention replies, a shell app, a
sixth tool, merge/push/PR controls, README/skill/manifest/version changes,
or a claim that every MCP host will render the cards.

## Testing

```
node --no-warnings --test test/r1-experience-ui.test.mjs
node --no-warnings --test test/r1-experience-ui-adversarial.test.mjs
node --no-warnings --test test/r1-experience-response.test.mjs test/r1-experience-response-adversarial.test.mjs
node --no-warnings --test test/v3-server.test.mjs test/v3-response.test.mjs
```
