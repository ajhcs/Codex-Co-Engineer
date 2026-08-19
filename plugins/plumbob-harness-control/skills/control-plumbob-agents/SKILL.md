---
name: control-plumbob-agents
description: Delegate review and implementation work to Grok, Cursor Local, Cursor Cloud, or DeepSeek Harness through the Codex-Co-Engineer ACP-first MCP supervisor. Use for parallel coding, review, task monitoring, worktree-isolated changes, or cancellation.
---

# Codex-Co-Engineer

Use the five MCP tools for delegation and lifecycle control.

1. Call `status` when provider or supervisor readiness is unknown.
2. Choose `grok`, `cursor-local`, `cursor-cloud`, or `dsh` for the task.
3. Call `delegate` with a stable task ID, an absolute Git root, and a clear prompt.
4. Use `role: review` for analysis and `role: implement` for changes.
5. Let Co-Engineer create and lock worktrees for every local task.
6. Poll `task` until terminal. Never replay an active or prompt-dispatched task.
7. Use `cancel` for an explicit cancellation or verified orphan recovery.
8. Inspect commits and receipts before merging. Codex owns final merge authority.

Grok and Cursor Local use persistent ACP sessions. DSH uses the official rc7
ACP composition through ACPX. Cursor Cloud uses the official Cursor SDK. A
local CLI fallback is allowed only when ACP fails before prompt dispatch.

Use normal persistent provider authentication. Never put credentials in MCP
arguments or prompts. Configured provider sessions are standing authorization
for task-scoped calls; preserve normal approval boundaries for deployments,
destructive Git operations, and merges.

All local tasks follow `one task -> one worktree -> one branch -> one writer`.
Cursor Cloud owns its cloud branch. Create a PR only when a task has
real commits; do not create empty PRs.

Prompts and repository content can leave the machine for the selected provider.
Send only material that provider is authorized to process.
