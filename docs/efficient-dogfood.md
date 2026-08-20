# Efficient Codex-Co-Engineer dogfood workflow

This workflow for Codex-Co-Engineer 3.2.0 minimizes coordination calls and
repeated receipt content without weakening Codex's review and merge
authority. The core pattern is:

```text
independent work -> parallel delegation -> one wait-any -> compact inspection
                 -> diagnostics only for attention/failure -> Codex review
```

The examples use neutral task IDs and paths. Every delegated writer still gets
one task, one managed worktree, and one branch.

## 1. Check readiness without loading receipts

Use a readiness-only status call before local delegation:

```json
{
  "detail": "compact",
  "include_tasks": false
}
```

When recent coordination state is useful, request only the number of compact
cards needed:

```json
{
  "detail": "compact",
  "task_limit": 6
}
```

`task_limit` accepts 0 through 20. `include_tasks: false` is the readiness-only
path and omits task cards. Full status remains available for compatibility and
deep inspection, but it should not be the routine readiness probe.

## 2. Delegate independent work in parallel

Split work at ownership boundaries that can be reviewed and merged as separate
commits or pull requests. Submit each task once; never replay a prompt merely
because a waiter disconnected.

```json
{
  "task_id": "change-api-validation",
  "provider": "grok",
  "repo": "/absolute/path/to/git-worktree",
  "role": "implement",
  "workspace_mode": "managed",
  "prompt": "Edit only packages/api and its focused tests. Implement the scoped validation change, test it, and commit once.",
  "expected_duration_ms": 1800000
}
```

```json
{
  "task_id": "update-operator-guide",
  "provider": "cursor-local",
  "repo": "/absolute/path/to/git-worktree",
  "role": "implement",
  "workspace_mode": "managed",
  "prompt": "Edit only docs/operator. Improve navigation and repair broken links without changing implementation or tests. Commit once.",
  "expected_duration_ms": 1200000
}
```

These two examples own disjoint paths and do not review each other's changing
state. Parallel delegation is appropriate only for independent ownership. Keep
one writer per managed worktree and branch, and serialize changes that edit the
same contract or generated artifact.

## 3. Replace polling loops with one wait-any

Coordinate up to eight exact tasks through the existing `tasks` tool:

```json
{
  "task_ids": [
    "change-api-validation",
    "update-operator-guide"
  ],
  "wait_until": "terminal",
  "wait_ms": 3600000
}
```

The wait shares one deadline across all targets and returns when the first task
reaches the requested condition. A terminal wait also wakes for
`needs_attention`, transport loss, silence, or a recorded deadline as
applicable. A timeout returns compact current snapshots for all targets. It
does not cancel provider work. Each wait-any task snapshot and live event
preview is bounded so an eight-target response cannot reproduce eight full
receipts. When an event preview is present, `progress.detail_hint` tells the
caller to use `task` with that target ID for full live event detail. Treat the
preview as coordination evidence, not the complete provider result.

Continue with the returned event cursor for each unfinished task so already
delivered progress does not wake the next call:

```json
{
  "task_ids": [
    "change-api-validation",
    "update-operator-guide"
  ],
  "cursors": {
    "change-api-validation": "1842",
    "update-operator-guide": "967"
  },
  "wait_until": "terminal",
  "wait_ms": 3600000
}
```

If `cursors` are omitted from a positive progress wait, the current event-log
tail becomes the baseline and the call waits for newer progress. Do not replace
this event-driven flow with short `task` or `tasks` polling intervals.

Calling `tasks` with no arguments retains the legacy recent-task list exactly.
Wait-any mode is selected by providing `task_ids` with 1 through 8 unique IDs.
Do not mix its wait-any properties (`task_ids`, `cursors`, `wait_ms`,
`wait_until`, `wake_on_needs_attention`) with list properties (`detail`,
`limit`, `cursor`, `provider`, `state`, `status`). `cursor` is one keyset list
cursor; `cursors` maps task IDs to event cursors.

Review work that depends on an implementation only after the writer is
terminal. Verify its recorded worktree, branch, and commit, then review that
exact checkout rather than starting the review in parallel with the writer:

```json
{
  "task_id": "review-api-validation",
  "provider": "dsh",
  "repo": "/absolute/path/to/recorded-writer-worktree",
  "role": "review",
  "workspace_mode": "direct",
  "prompt": "Review the committed implementation on the recorded branch. Do not modify files; report actionable correctness findings.",
  "expected_duration_ms": 1200000
}
```

Use `direct` here intentionally only after the writer has stopped. Codex must
confirm that the review receipt still identifies the expected branch and HEAD.

## 4. Inspect compact first

For a routine result or handoff, request the bounded compact projection:

```json
{
  "task_id": "change-api-validation",
  "view": "compact"
}
```

The compact task's structured JSON is capped at 8,192 UTF-8 bytes. It includes
coordination state, progress cursor, bounded result and handoff previews, and
the diagnostic summary without returning full task or runtime bodies. This is
an MCP-server payload guarantee. It is not evidence of, or a claim about, a
hard payload limit in the Codex desktop renderer.

Use `view: "summary"` when the full sanitized receipt is actually required.
Use `view: "diagnostics"` only after an attention or failure signal, or when a
task appears stuck:

```json
{
  "task_id": "change-api-validation",
  "view": "diagnostics",
  "cursor": "1842",
  "max_bytes": 8192
}
```

Diagnostics are redacted, byte-bounded, side-effect-free pages. Follow their
cursor until the required evidence is covered; do not repeatedly reread page
one. Provider terminal results retain the conclusion-oriented tail. Text and
nested values are bounded and redacted, including credentials split across
stream chunks. A clipped result sets `result_truncated: true` and includes
`result_original_chars` when the original count is knowable. Character counts
are Unicode code points; diagnostic and structured payload caps are UTF-8
bytes.

## 5. Page task history intentionally

For coordination history, use a compact keyset page:

```json
{
  "detail": "compact",
  "limit": 20,
  "provider": "grok",
  "state": "running"
}
```

Use the returned opaque `next_cursor` for the next page without changing
`provider`, `state`/`status`, or `detail`. The cursor is bound to those filters
and orders tasks by creation time and task ID, so insertions or deletions do
not create offset-pagination drift. Page size is 1 through 20. Compact mode
defaults to 20; full mode retains the legacy unbounded default when no paging
arguments are supplied.

## 6. Opt into structured transport only for a capable client

All five tools accept the optional presentation property:

```json
{
  "response_mode": "structured"
}
```

In structured mode, `structuredContent` is authoritative and
`content[0].text` is only a bounded, redacted fallback with truthful truncation
metadata. Omit `response_mode` for exact backwards compatibility:
`content[0].text` remains `JSON.stringify(structuredContent)`. Structured mode
therefore saves duplicated text only when the calling client actually consumes
`structuredContent`. Keep the property out of routine examples and never set
it for a text-only client, which would otherwise receive only the fallback.

## 7. Treat preflight as an identity boundary

Cursor Cloud requires a clean Git checkout and an exact pushed 40-character
commit SHA:

```json
{
  "task_id": "cloud-release-review",
  "provider": "cursor-cloud",
  "repo": "/absolute/path/to/clean-checkout",
  "role": "review",
  "starting_ref": "0123456789abcdef0123456789abcdef01234567",
  "prompt": "Review this exact release candidate and report blockers.",
  "expected_duration_ms": 3600000,
  "create_pr": false
}
```

Before any provider SDK call, the supervisor pins the checkout SHA and a
canonical, credential-free provider origin. The worker verifies that the
checkout is still clean, `HEAD` still equals the pinned SHA, and a derived
origin still has the same repository identity. An explicit provider-repository
override remains explicit and is validated as such. If the checkout or origin
changes, create a new task from the intended exact commit; do not allow a stale
receipt to dispatch a different tree.

Managed local delegation similarly validates the bootstrap receipt against the
actual worktree: task identity, Git root, branch, starting SHA, and current
`HEAD` must agree before provider launch. This prevents a shape-valid but stale
or forged workspace receipt from selecting another tree.

## Review and merge remain Codex work

A terminal provider verdict is evidence, not merge authority. Codex should
inspect the compact handoff, open the relevant diagnostics page when needed,
verify the exact diff and tests in the recorded worktree, and only then push,
open, or merge a pull request. Keep task receipts until that handoff is no
longer needed, then clean only the exact recorded worktree, branch, and task
state.
