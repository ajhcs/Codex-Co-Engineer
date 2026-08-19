# Release process

The authoritative gate runs once against one exact clean local candidate:

```sh
release-gate plan --repo "$PWD"
release-gate run --repo "$PWD"
```

The package supports Node.js 24 and newer. The release gate is intentionally
pinned to Node.js 24, MCP Inspector 2.2.0, and the recorded ACPX/DSH
provenance so the release receipt is reproducible. The gate validates the
thin five-tool catalog (with durable wait/diagnostics/reply parameters on
`task`), package contents, provider-free Inspector smoke test,
ACPX reproducibility/provenance, and both package inventories. It does not
require provider credentials or send repository content to a model.

GitHub Actions mirrors the portable stages. It is diagnostic evidence, not a
replacement for the exact-tree local receipt.

## Host acceptance

After the provider-free gate passes:

1. Run `npm run setup:check` on the target host.
   This validates DSH/ACPX, the Cursor SDK, and `worktree-bootstrap`
   dependencies. It does not install or authenticate Grok or Cursor Local,
   validate their CLIs or the Cursor Cloud key, or prove the local process
   boundary. Use the `status` tool to check provider readiness.
2. Validate Linux `systemd --user`, `systemd-run` 244 or newer, and unified
   cgroup v2 with the release/live process-boundary acceptance. The
   manager-owned transient systemd user service uses
   `KillMode=control-group` solely for descendant cleanup and to survive the
   launching client; it is not a sandbox or capability restriction.
3. Verify persistent normal authentication for Grok and Cursor Local, the
   owner-only DSH model key, and the owner-only Cursor Cloud API key.
4. Run one bounded opt-in acceptance task through Grok, Cursor Local, Cursor
   Cloud, and DSH.
5. For local tasks, verify ACP first; if fallback occurs, prove it happened
   before prompt dispatch. DSH ACPX receipts may be `dispatch_uncertain` after
   spawn because ACPX has no authoritative prompt-sent acknowledgement; those
   tasks are never replayed. Verify terminal receipts, zero active tasks, clean
   direct-mode caller checkouts, and retained managed-worktree handoffs.
6. For Cursor Cloud, use a clean checkout with a provider-accessible origin
   and an exact immutable `starting_ref` commit SHA that is already pushed.
   An exact SHA reachable only from a feature branch can remain invisible to
   Cursor until an open PR or default-branch reachability makes it
   provider-visible. Create the draft PR before final Cloud acceptance (or
   make the commit reachable from the default branch). Surface a provider
   HTTP 400 for an otherwise-valid SHA as a visibility check/failure in the
   receipt, fix reachability, and only then retry. Verify the remote run,
   branch, and any PR are archived or accounted for.
7. Inspect the packed payload and current commit metadata for credentials,
   personal paths, and machine-specific information. Live receipts remain
   local and owner-only. They may contain bounded agent output/code context and
   must be treated as private state; verify that prompts and credentials are
   redacted.
8. Record the longest Codex Desktop MCP pending-call interval using
   [mcp-pending-call.md](mcp-pending-call.md). Do not treat the advertised
   4-hour `tool_timeout_sec` as a measured Desktop limit until those probes
   have been run on the shipping host.

## Handoff and cleanup

Codex reviews and merges. Managed local worktrees remain until their result is
accepted or deliberately discarded:

```sh
worktree-bootstrap handoff TASK --repo /absolute/worktree --format markdown
worktree-bootstrap lock inspect TASK --repo /absolute/worktree
worktree-bootstrap lock clean TASK --repo /absolute/worktree \
  --policy dead-local --lock-id LOCK_ID
git worktree remove /absolute/worktree
```

Use the exact lock ID reported by inspection; never delete a lock by hand.
Remove only the corresponding branch and terminal task-state directory after
the receipt is no longer needed. Direct-mode tasks have no managed worktree.
Cursor Cloud remote branches and PRs are provider artifacts and require
explicit review/closure.

Open the release PR only after the local gate, CI, package/privacy review, and
independent provider review pass. `create_pr` is Cloud-only; local workers
return commits and handoff evidence for Codex to decide whether a PR should be
opened. Never create an empty PR.
