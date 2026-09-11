# Co-Engineer troubleshooting

Give Codex a team of external co-engineers without giving up control.

Ask Codex in ordinary language first. You do not write tool payloads.
Any extra Co-Engineer panel is optional, feature-detected, and
host-specific. Missing UI is not a failed install; the headless
Delegating/Chatting conversation is complete.

## Status and local readiness

**How do I check whether Codex-Co-Engineer can dispatch locally?**
Ask Codex: `Show Codex-Co-Engineer status.` Local providers are ready
only when `local_boundary.ready` is true. If it is false, the MCP
process is missing Linux `systemd --user`, `systemd-run` 244+, unified
cgroup v2, or the forwarded user-session locators (`XDG_RUNTIME_DIR`,
`DBUS_SESSION_BUS_ADDRESS`).

**Setup passed, but local providers are unavailable.**
`setup:check` does not prove the MCP environment. Re-run status from the
actual MCP server process, then confirm the plugin `.mcp.json` allowlist
forwards `HOME`, `PATH`, `XDG_*`, and `DBUS_SESSION_BUS_ADDRESS`.

Local dispatch fails closed when that boundary cannot be verified. The
check occurs before Codex-Co-Engineer creates a managed worktree, task
receipt, or prompt file. `systemd --user` with
`KillMode=control-group` is a lifecycle/cleanup boundary, not a sandbox.

## Install path

**Where is the installed plugin?**
After `codex plugin add codex-co-engineer@codex-co-engineer`, Codex
reports the cached install path. The source package in this repository
is `plugins/codex-co-engineer`. Run `npm run setup` from that source
package (or with `npm --prefix plugins/codex-co-engineer`) rather than
guessing a cache path.

Start a **new** Codex session after the plugin add. Setup installs
pinned ACPX `0.13.0`, Cursor SDK `1.0.28`, and the cohesive DSH
`0.1.0-rc.7` composition. It does not log you into Grok, Cursor Local,
or Cursor Cloud.

**The plugin cache reverts after Windows Desktop reconnects to a remote host.**
A host-only cache restore is not durable if the Desktop client resyncs an older
copy. Add or update the exact local marketplace and install and test the plugin
on the Desktop computer too, following the
[official local-plugin install guide](https://developers.openai.com/plugins/build/plugins):

```text
codex plugin marketplace add LOCAL_ROOT
codex plugin add codex-co-engineer@codex-co-engineer
```

Treat client-to-host resync as suspected until versions or file hashes confirm
it. Do not add an auto-repair cron, replace the cache with a symlink, or disable
unrelated configuration to mask the problem.

## Worktrees and cleanup

**A managed worktree appeared without a receipt.**
Do not guess or delete it. Inspect `git worktree list` and
`worktree-bootstrap lock inspect`, then clean only an exact identified
task/lock.

Managed local work keeps one writer per worktree and branch. If
bootstrap fails before an authoritative receipt and path, the supervisor
cannot safely identify an unknown worktree.

After Codex has inspected a complete candidate, clean only the exact
corresponding branch, lock, and terminal task-state directory. Direct
3.2.1 tasks have no managed worktree; review their caller checkout
explicitly.

## Cursor Cloud

**Cursor Cloud returned HTTP 400 for a valid SHA.**
Treat it as a provider visibility failure. Make the commit reachable
from an open PR or the default branch, then retry. Do not replay a
prompt that was already dispatched.

Cursor Cloud does not use a local worktree. A bounded-run Cloud lane
needs a provider-accessible origin and an exact already-pushed commit
SHA. Individual 3.2.1 Cloud tasks still treat that SHA as optional.

**Cursor Cloud completed, but the answer is incomplete.**
`completed` proves terminal lifecycle state; it does not prove that the answer
satisfies the task. Codex must inspect the actual result before accepting it.
If the SDK transcript and result both contain only the same progress sentence,
record the task outcome as incomplete. Do not infer a hidden final answer from
natural language and do not replay the prompt automatically.

## Credentials

**Can I put API keys in the MCP tool arguments?**
No. Use normal provider login or the owner-only key files. Credentials
must not appear in MCP arguments, prompts, receipts, fixtures, or Git.

- Grok: `grok login`, or `grok login --device-auth` when a browser is
  unavailable. Subscription login only; no API key is required for a Grok
  first outcome.
- Cursor Local: `cursor-agent login`
- Muse and optional Ox Alpha: `OPENROUTER_API_KEY`,
  `CODEX_CO_ENGINEER_OPENROUTER_API_KEY_FILE`, or
  `~/.config/codex-co-engineer/openrouter-api-key`
- Cursor Cloud: `CURSOR_API_KEY`, `CURSOR_API_KEY_FILE`, or
  `~/.config/cursor-cloud-control/api-key`

## Conversation surprises

**Chatting did nothing.**
`Chatting with Co-Engineer` needs an existing run. It inspects,
continues, answers grouped attention, or cancels. If no run exists,
Codex should say chatting needs existing work and offer to delegate. It
must not silently submit.

**Codex asked which co-engineers to use.**
That is the one allowed ask when no profile and no named co-engineers
exist. Answer Grok, Cursor, or Muse. Codex does not invent a default
router.

**Codex did not say the work was verified.**
A required assignment failed, could not be answered, or stayed
unresolved. A required gap blocks a complete candidate. Codex must not
say `Co-Engineer finished, and I verified the candidate.` Cancel is
chatting, not a new delegation.

**More than one assignment asked a question.**
Codex groups those questions into one decision:

> Co-Engineer needs one decision from you.

Answer once. Unaffected assignments keep working. That is not a second
delegation and not a debate loop.

**This host has no Co-Engineer UI.**
Use the headless conversation. This documentation does not claim a
Co-Engineer UI on every Codex Desktop host.

## Related

- [Quickstart](co-engineer-quickstart.md)
- [3.2.1 migration](co-engineer-migration-3.2.1.md)
- [Configuration](configuration.md)
- [Repository README](../README.md)
