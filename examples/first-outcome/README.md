# First outcome example

Tiny public assignment you can copy into a **clean Git repository**. It needs no
paid provider to verify: acceptance is a local Node check.

## Contents

| File | Role |
| --- | --- |
| `lib/version.js` | Outcome string the assignment must set |
| `check.mjs` | Deterministic acceptance check |
| `starter-prompt.md` | Ordinary-language request for Codex |

## Compatibility before providers

On the Co-Engineer host you still need the published local requirements when
using a local worker: **Linux**, working **`systemd --user`**, **`systemd-run`
244+**, unified **cgroup v2**, **Node.js 24+**, and **Python 3.11+** for bundled
setup. Authenticate **one** chosen provider only. Bundled `npm run setup` may
install shared prerequisites for the package; it does not selectively install
only the provider you picked.

## Try it

1. Copy this directory into a new empty Git repository and commit the files.
2. Confirm the shipped golden state:

```bash
node check.mjs
```

3. Optional live demo: change `lib/version.js` so it exports `0.0.0`, commit,
   then in a Codex session use [starter-prompt.md](starter-prompt.md) with your
   one chosen provider (for example Grok Co-Engineer). When the candidate is
   ready, run `node check.mjs` again.

Do not construct MCP payloads. Speak in ordinary language. Codex remains the
reviewer. External workers may commit within their assigned scope. Publication
and merge require user authorization and Codex review.
