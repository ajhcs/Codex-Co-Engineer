# Migrating from Codex-Co-Engineer 3.2.1

Give Codex a team of external co-engineers without giving up control.

3.2.1 is the last single-task visitor path. Later published notes added
a bounded run on the same five-tool catalog. This onboarding describes
that run in public language. It does not publish a new package version.

The honest shape is up to eight isolated external co-engineers, one
bounded run, one coordinated wait, one verified decision.

## What stays the same

- Identifier: `codex-co-engineer`
- Catalog: `status`, `delegate`, `task`, `tasks`, `cancel`
- There is no sixth tool
- Install, setup, and authentication commands
- Pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and DSH `0.1.0-rc.7`
- Codex remains chief engineer, reviewer, and merge authority

Omit additive run fields and exact 3.2.1 single-task behavior remains,
including compact views, wait-any, structured transport, the Muse
default, and the optional Ox Alpha selector.

## What changes for normal use

Stop constructing a tool payload as the first-run habit. In a new Codex
session say:

> Delegating to Co-Engineer: review the auth change with Grok Co-Engineer.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Co-Engineer is running 1 independent assignment.

That one submission replaces a 3.2.1 `delegate` plus a separate
`wait_until: "terminal"` loop in the visitor path. Codex waits once, then
inspects:

> Co-Engineer finished, and I verified the candidate.

`Chatting with Co-Engineer` inspects, continues, answers grouped
attention, or cancels that existing run. Chatting is not a second
3.2.1-style submit.

Public names are `Using Grok Co-Engineer`, `Using Cursor Co-Engineer`,
and `Using Muse Co-Engineer`. Cursor Local and Cursor Cloud both stay
Cursor Co-Engineer in public speech.

## Compatibility facts

- Direct mode remains available only for 3.2.1 single-task `delegate`.
  Bounded-run submissions never use direct mode.
- Individual 3.2.1 Cursor Cloud tasks still treat `starting_ref` as
  optional. Every bounded-run Cloud lane must pin one exact
  already-pushed provider-visible SHA.
- `create_pr` remains Cursor Cloud-only and defaults to `false`. Local
  tasks still reject it.
- Mixing a run body with 3.2.1 `task_id` / `workspace_mode` /
  `create_pr` / `reply` fields fails closed.
- Provider and model are explicit or filled from one named data-only
  profile. Missing selection is one ask, not a router.

## UI

Any extra Co-Engineer panel is optional, feature-detected, and
host-specific. Complete headless fallback remains: Codex CLI with
Delegating and Chatting is enough. Do not treat a missing Codex Desktop
panel as a 3.2.1 incompatibility.

## Advanced Co-Engineer Control/API

JSON belongs only in this labeled material and in
[configuration](configuration.md). A 3.2.1 single-task review still
looks like:

```json
{
  "task_id": "review-auth-refactor",
  "provider": "grok",
  "repo": "/absolute/path/to/git-worktree",
  "role": "review",
  "workspace_mode": "managed",
  "prompt": "Review the current branch and report concrete correctness risks.",
  "expected_duration_ms": 600000
}
```

The repository argument remains the literal property `repo`. Send
`"repo": "/absolute/path/to/git-worktree"`. Do not rename it.

A bounded-run wait uses `wait_until: "decision_or_attention"` instead of
polling each assignment. Routine progress never wakes that wait.

## Next

- [Quickstart](co-engineer-quickstart.md)
- [Troubleshooting](co-engineer-troubleshooting.md)
- [Published 3.3.0 notes](releases/v3.3.0.md)
