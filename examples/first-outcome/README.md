# First outcome example

Tiny public assignment you can copy into a **clean Git repository**. Its local
acceptance check needs only Node, with no `package.json` or `npm install`.
Delegating the implementation uses your chosen provider's account and usage.

The shipped library is an **intentionally incomplete stub**. `node check.mjs`
fails until a provider implements the summarizer. After a useful outcome, the
same check passes.

## Contents

| File | Role |
| --- | --- |
| `lib/summarize-checks.cjs` | Stub to implement: summarize named check JSON |
| `summarize-checks.mjs` | Local CLI (`stdin` or a file path argument) |
| `check.mjs` | Frozen deterministic acceptance (do not edit to pass) |
| `starter-prompt.md` | Ordinary-language request for Codex |

## What the utility does

Input is a JSON array of `{ "name": string, "status": "passed"|"failed"|"skipped" }`.
Output is deterministic text, for example after a mixed run:

```text
passed: 1
failed: 2
skipped: 1
failures:
- unit
- typecheck
```

An empty JSON array (`[]`) prints zero counts and an empty `failures:` list.
Empty stdin is invalid JSON and exits non-zero. Other invalid JSON, missing
names, or unknown statuses also exit non-zero with an error on stderr.

## Compatibility before providers

On the Co-Engineer host you still need the published local requirements when
using a local worker: **Linux**, working **`systemd --user`**, **`systemd-run`
244+**, unified **cgroup v2**, **Node.js 24+**, and **Python 3.11+** for bundled
setup. Authenticate **one** chosen provider only. Bundled `npm run setup` may
install shared prerequisites for the package; it does not selectively install
only the provider you picked.

## Clean Git copy and commit

From a Co-Engineer source checkout, create an empty repository and copy only
this example (no personal home paths):

```bash
mkdir first-outcome-demo
cd first-outcome-demo
git init
cp -R /path/to/Codex-Co-Engineer/examples/first-outcome/. .
git add .
git commit -m "Add first-outcome starter fixture."
```

Replace `/path/to/Codex-Co-Engineer` with your local clone of this repository.

## Try it

1. After the copy/commit above, confirm the stub fails acceptance:

```bash
node check.mjs
```

Expect a non-zero exit while `summarizeChecks` is unimplemented.

2. In a Codex session, use [starter-prompt.md](starter-prompt.md) with your one
   chosen provider (for example Grok Co-Engineer). Do not let the worker edit
   `check.mjs` to pass.

3. When the candidate is ready, run acceptance again:

```bash
node check.mjs
```

Expect `first-outcome acceptance passed` and exit 0. You can also exercise the
CLI directly:

```bash
printf '%s\n' '[{"name":"lint","status":"passed"},{"name":"unit","status":"failed"}]' \
  | node summarize-checks.mjs
```

Do not construct MCP payloads. Speak in ordinary language. Codex remains the
reviewer. External workers may commit within their assigned scope. Publication
and merge require user authorization and Codex review.
