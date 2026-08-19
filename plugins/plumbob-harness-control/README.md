# Codex-Co-Engineer

Codex-Co-Engineer is the Codex-first MCP control plane for the standalone
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
official [Grok Build CLI](https://docs.x.ai/build/cli/headless-scripting). It
submits bounded background work, reports a durable lifecycle, and lets Codex
inspect or cancel plugin-owned jobs without opening a shell. Version 2 removes
all Prime Intellect adapters and runtime dependencies; the only worker kinds
are `deepseek_agent` and `grok_build`.

This README documents Co-Engineer `2.2.0`; the stable plugin and MCP
identifier remains `plumbob-harness-control`.

The public product name is **Codex-Co-Engineer**. The stable plugin and MCP
identifier remains `plumbob-harness-control` so existing Codex configurations
and automation continue to resolve the same server.

## What it provides

The MCP server exposes seven compact tools plus an explicit control-plane
target-binding convenience path:

- Co-Engineer MCP `preflight`: resolve and attest one strict target/configuration
- Co-Engineer MCP `status`: provider-free control-plane, adapter, credential-presence, and recent-job state
- Co-Engineer MCP `capacity`: explicit read-only Codex, Grok, and DSH capacity/usage snapshot
- Co-Engineer MCP `runtime`: start or stop the optional loopback DeepSeek UI
- Co-Engineer MCP `run`: accept a target-bound `deepseek_agent` or `grok_build` job
- Co-Engineer MCP `jobs`: list, inspect, wait for, or cursor-page a managed job; terminal Grok
  jobs also expose a bounded final response without requiring callers to parse
  the full provider log
- Co-Engineer MCP `cancel`: request cancellation of one plugin-owned job

The control plane stores only bounded metadata and redacted logs in an
owner-only state directory. It does not accept arbitrary shell commands,
ports, provider URLs, or environment maps as tool arguments.

Provider CLIs run inside the control plane's managed process-group lifecycle.
They may use their documented in-session background-job and subagent features,
but must not daemonize or reparent work outside that lifecycle. Such detached
processes are outside the supported worker contract and cannot be reliably
cancelled or included in the final target snapshot.

Grok internal subagents are supported and enabled unless a request explicitly
disables delegation. DSH's installed profile advertises its internal subagent
and fork tools. Receipts distinguish supported, requested, and effective
delegation; `effective` remains `unknown` unless provider output proves that a
child actually ran. These are harness-internal workers, not extra public MCP
tools and not Codex-native subagents.

## Install

1. Install Node.js 24 or newer. Runtime packages support Node 24+, while the
   reproducible maintainer release gate is intentionally pinned to Node major
   24.
2. Install and authenticate the official Grok Build CLI separately when using
   `grok_build`, following [xAI's headless CLI instructions](https://docs.x.ai/build/cli/headless-scripting).
   Use `grok login` (or `grok login --device-auth` on a remote host), or
   provide `XAI_API_KEY` through the MCP server process environment.
   Codex-Co-Engineer never installs the CLI, opens a browser, or accepts
   credentials as tool arguments.
3. Install and configure DeepSeek Harness separately when using DeepSeek jobs.
   A `deepseek_agent` run also requires `MODEL_API_KEY` in the MCP process
   environment or an owner-only model-key file. The default file is under
   `XDG_CONFIG_HOME` and can be overridden with
   `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE`. If neither source is available,
   dispatch fails closed with `missing_credential` before a DSH worker is
   submitted.
4. Add the repository root as a Codex marketplace and install the
   `plumbob-harness-control` entry. The public root catalog and the complete
   command sequence are in the repository [README](../../README.md).
5. Set the runtime environment described below before Codex starts the MCP
   server. If the task sandbox makes the normal home directory read-only,
   provide the host-provisioned `CODEX_TASK_STATE_ROOT` (Co-Engineer uses its
   `codex-co-engineer` child directory), or an explicit
   `CODEX_CO_ENGINEER_STATE_DIR`. Status reports the exact readiness reason and
   dispatch fails before a DSH worker is submitted when no durable root is
   usable.

The plugin has no runtime npm dependencies. DeepSeek Harness and Grok Build are
installed and authenticated independently. The public repository deliberately
does not include generated Harness profiles, session logs, or credentials.

### Register the plugin in Codex

The current Codex CLI uses a marketplace index for plugin registration. The
public repository ships that index at `.agents/plugins/marketplace.json`; add
the repository root as a marketplace and select this plugin:

```bash
codex plugin marketplace add ajhcs/Codex-Co-Engineer --ref main
codex plugin marketplace list --json
codex plugin list --available --json
codex plugin add plumbob-harness-control@codex-co-engineer
codex plugin list --json
```

`codex plugin add ./plugins/plumbob-harness-control` is not a supported
command. The Codex App reads the enabled plugin configuration after
activation. Fully restart the App and start a fresh task after installing or
changing a plugin: `codex plugin list --json` verifies installation/enabled
state, while an existing task can retain a stale MCP or skill catalog.

### First status, preflight, and run

In the fresh Codex task, use the plugin tools in this order:

1. Co-Engineer MCP `status` with `{}`. This is provider-free by default. Add
   `{"diagnostics":true}` only when a bounded read-only Grok auth probe is
   needed.
2. Co-Engineer MCP `preflight` with `schema_version: "codex-co-engineer.config.v1"`,
   `kind: "preflight"`, `target_binding: "control_plane"`, and one exact
   `target_context`. A local target uses `mode: "explicit"`, absolute
   `working_directory` and `expected_git_root`, its current 40-character
   `expected_head`, `allowed_paths`, and `role: "review"` or `"verify"`.
   A GitHub target can use `mode: "staged"` and
   `source: {"type":"github","repository":"https://github.com/OWNER/REPOSITORY","ref":"main"}`.
3. Co-Engineer MCP `run` with the same target context, a stable `request_id`, text-only
   `prompt`, and exactly one worker kind: `deepseek_agent` or `grok_build`.
   `target_binding: "control_plane"` lets the connector compute the target
   fingerprint; it does not weaken path, HEAD, identity, or postflight checks.
4. Monitor the returned job with the Co-Engineer MCP `jobs` tool using
   `{"action":"wait","job_id":"<id>","until":"terminal"}`, then inspect it
   with `{"action":"get","job_id":"<id>"}`.

For a manual, provider-free end-to-end check from the repository root, run
`node scripts/inspector-preflight.mjs`; the exact custom-target form is in
[`docs/preflight-inspector.md`](../../docs/preflight-inspector.md). The public
release history is in [`CHANGELOG.md`](../../CHANGELOG.md).

## Configuration

The MCP server receives configuration through its process environment. A
portable example is in [`config/configuration.example.json`](../../config/configuration.example.json).

| Variable | Purpose |
| --- | --- |
| `MODEL_API_KEY` | DSH provider credential for `deepseek_agent` runs, supplied by the environment or a secret manager. |
| `XAI_API_KEY` | Optional xAI API key for the official Grok CLI; OAuth/session state remains under the normal user home. Never pass it as an MCP argument. |
| `DSH_HOME` | Optional absolute DeepSeek Harness profile/state home. When omitted, Co-Engineer uses its managed `dsh-home` beneath the configured state directory and never falls back to the protected per-user DSH home. |
| `CODEX_CO_ENGINEER_DSH_HOME` | Preferred explicit absolute DeepSeek Harness profile/state home. Relative paths fail closed. |
| `CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` | Default Git workspace selected only by an explicit `target_context.mode: "default"`; it is not prompt-derived authority. |
| `CODEX_CO_ENGINEER_ALLOWED_ROOTS` | Optional path-delimited administrator allowlist for local Git roots. |
| `CODEX_CO_ENGINEER_STATE_DIR` | Preferred owner-only state, SQLite ledger, cancellation markers, redacted logs, and the default managed DSH profile/state root. Must be absolute; an empty or relative value fails closed. |
| `PLUMBOB_HARNESS_STATE_DIR` | Legacy explicit alias for `CODEX_CO_ENGINEER_STATE_DIR`; it is used only when the preferred variable is absent. |
| `CODEX_TASK_STATE_ROOT` | Host-provisioned shared durable root. When component-specific settings are absent, Co-Engineer uses `${CODEX_TASK_STATE_ROOT}/codex-co-engineer`; an empty or relative value fails closed instead of falling back. |
| `XDG_STATE_HOME` | Absolute fallback state root; Co-Engineer uses `${XDG_STATE_HOME}/codex-co-engineer` when no explicit or host-shared root is configured. A present empty or relative value fails closed instead of falling through to HOME. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Optional protected file fallback containing only the DSH provider key; keep it outside the clone. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | Optional DeepSeek Harness executable override; defaults to `dsh`; passed to `spawn` without a shell. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Optional direct Grok executable override; defaults to `grok`; passed to `spawn` without a shell. |

Legacy `PLUMBOB_HARNESS_*` names remain compatibility aliases.

Every state path component is identity-revalidated without following symbolic
links. Non-sticky group/world-writable ancestors are rejected (a sticky shared
ancestor such as `/tmp` remains valid), and the final state and jobs directories
must be owned by the process user with mode `0700`. The daemon log, lock, Unix
socket, SQLite ledger, and any SQLite WAL/SHM sidecars are restricted to mode
`0600`, one link, and the same owner. Node's synchronous SQLite API is path-only,
so Co-Engineer pre-creates or validates the ledger with `O_EXCL|O_NOFOLLOW` and
revalidates it before and after opening. The identity-bound `0700` directory is
therefore the explicit same-uid trust boundary for the unavoidable path-open
interval; pre-existing symlinks and other unsafe objects are rejected.

## MCP tool calls

The seven MCP tools are intentionally narrow; removing Prime narrows only the
accepted worker kinds and backend-specific fields.

- Co-Engineer MCP `preflight` is read-only. Existing callers may supply the caller-computed
  `expected_target_fingerprint`. For normal Codex use, set
  `target_binding: "control_plane"` and the connector computes and binds the
  exact target identity itself; supplying a fingerprint alongside that opt-in
  is still checked. Set `kind` to `preflight`, `deepseek_agent`, or
  `grok_build`. A Grok preflight may include the same typed Grok options
  accepted by the Co-Engineer MCP `run` tool.
- Co-Engineer MCP `status` accepts optional `recent_limit` (`0`–`15`) and
  `diagnostics`. Recent jobs and Co-Engineer MCP `jobs` action `list` return
  bounded summaries only; use that `jobs` tool's action `get` for one job's
  effective configuration and lifecycle history.
  The normal path is provider-free. `diagnostics: true` is the existing
  explicit, bounded read-only `grok models` authentication probe; it is not a
  capacity query and is never started automatically.
- Co-Engineer MCP `capacity` is the one explicit provider-read surface. It is read-only and
  accepts `providers` (`codex`, `grok`, or `dsh`), `refresh`, bounded
  `max_age_seconds`, `include_usage`, `grok_session_id`, and `dsh_job_id`.
  Codex reads official App Server rate-limit/credit data (and optional
  account usage); Grok reads official ACP billing data (and optional exact
  session usage). DSH/Muse account remaining capacity, reset time, and dollar
  spend are unsupported and never inferred. DSH token usage is returned only
  for an exact job with a validated trusted receipt.
- Capacity snapshots are compact and cached independently per provider and
  selector (60 seconds by default). `refresh: true` bypasses the cache;
  failed refreshes retain the last known snapshot as `stale` with an error,
  rather than fabricating zeros. Provider credentials come from the existing
  configured sessions/environment; capacity never accepts credentials or
  requests a per-call egress/authorization prompt.
- Co-Engineer MCP `runtime` accepts `action: "start"` with the versioned target contract and a
  bounded timeout, or `action: "stop"` to stop only the plugin-owned DeepSeek
  UI job.
- Co-Engineer MCP `run` requires `schema_version`, `kind`, `request_id`, `prompt`, and
  `target_context`. Existing callers may continue supplying
  `expected_target_fingerprint`; normal Codex callers can explicitly set
  `target_binding: "control_plane"` to bind the resolved target without
  computing inode values by hand. `kind` is exactly `deepseek_agent` or
  `grok_build`; unknown and removed kinds fail closed.
- Co-Engineer MCP `jobs` accepts `action: "list"`, `"get"`, `"wait"`, or `"logs"`. Waits are
  bounded to 55 seconds per call and log reads use byte cursors. A terminal
  Grok `get` includes only a bounded final assistant response; reasoning and
  tool events are not promoted into that field.
- Co-Engineer MCP `cancel` requires one exact `job_id` and signals only a process whose
  ownership the plugin can prove.

Minimal DeepSeek dispatch after a successful preflight:

```json
{
  "schema_version": "codex-co-engineer.config.v1",
  "kind": "deepseek_agent",
  "request_id": "review-example-001",
  "prompt": "Review the requested files and report findings.",
  "target_binding": "control_plane",
  "target_context": {
    "schema_version": "codex-co-engineer.target.v1",
    "mode": "explicit",
    "working_directory": "/absolute/path/to/checkout",
    "expected_git_root": "/absolute/path/to/checkout",
    "expected_head": "0123456789abcdef0123456789abcdef01234567",
    "allowed_paths": ["src", "tests"],
    "role": "review"
  }
}
```

This explicit `target_binding: "control_plane"` path is the normal ergonomic
form: the connector resolves the target and binds its exact fingerprint. For
advanced callers that hold target authority themselves, omit `target_binding`
and provide the `expected_target_fingerprint` returned by
`scripts/target-fingerprint.mjs`; the connector still resolves and checks the
same paths, Git HEAD, and directory identities.

For Grok, change `kind` to `grok_build` and optionally add typed fields such as
`model`, `reasoning_effort`, `max_turns`, `sandbox_profile`, `allowed_tools`,
or the structured-output controls described below. Credentials, executable
paths, raw arguments, shell commands, environment maps, and provider URLs are
never accepted in a tool call.

For a normal read-only review of a clean local checkout or public/private GitHub
repository, use the explicit control-plane binding convenience form. A staged
source is cloned into the owner-only Co-Engineer state directory, its exact
HEAD and directory identities are resolved there, the origin remote is removed
before the provider starts, and the resulting target remains subject to the
same runner preflight/postflight checks. The original checkout is never
modified. Local sources with uncommitted or untracked files fail closed rather
than silently omitting those changes. Staging uses a deterministic source/ref/
HEAD lease, so repeated preflight and run calls reuse one checkout; unused
leases expire after 24 hours and the control plane keeps at most eight
inactive leases.

Private staged GitHub sources require credentials that Git can use
noninteractively from the MCP server process. Configure an owner-approved
credential helper, askpass/secret-manager integration, or equivalent process
environment before calling the Co-Engineer MCP `preflight` tool; staging
forces `GIT_TERMINAL_PROMPT=0`. The source URL must remain credential-free, and
credentials must never appear in `target_context`, prompts, or tool
arguments. A clone or ref lookup that cannot authenticate fails closed before
dispatch.

```json
{
  "schema_version": "codex-co-engineer.config.v1",
  "kind": "grok_build",
  "request_id": "review-github-example-001",
  "target_binding": "control_plane",
  "prompt": "Review this repository and return only actionable findings.",
  "target_context": {
    "schema_version": "codex-co-engineer.target.v1",
    "mode": "staged",
    "source": {
      "type": "github",
      "repository": "https://github.com/OWNER/REPOSITORY",
      "ref": "main"
    },
    "allowed_paths": ["."],
    "role": "review"
  }
}
```

Use `mode: "explicit"` with `target_binding: "control_plane"` when a clean
local checkout is already in a suitable non-temporary directory; this avoids a
second clone while retaining exact target identity and runner checks. Staging
is opt-in and never replaces the caller-asserted contract silently.

Prefer a native per-user secret store. If a file is necessary, place it under
the platform's user configuration directory, restrict it to the current user,
and never put it under this repository or a Windows-mounted shared directory.

## Target contract

Every operation that dispatches work must resolve exactly one target before a
worker starts. The target contract contains:

- absolute `working_directory` and `expected_git_root`
- expected Git `HEAD`
- relative `allowed_paths`
- `role`: `review`, `verify`, or `implement`
- a target fingerprint, either caller-asserted or computed by the explicit
  control-plane binding

The connector canonicalizes the resolved target and configuration, computes
digests, and fails closed on a mismatch. An explicit malformed target is an
error; it never falls back to a default workspace. A prompt containing `cd`
is descriptive text, not target authority. See
[`docs/target-contract.md`](../../docs/target-contract.md) and
[`examples/target-context.json`](../../examples/target-context.json).

Review and verify roles are read-only. Implement roles are limited to their
allowlist and must produce a recoverable patch only after scope verification.
Never reuse a checkout marked tainted after timeout or cancellation until it
has been inspected independently.

## Preflight and lifecycle

Run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
against the exact server command before dispatch. The preflight receipt must
include the target fingerprint, resolved workspace and cwd, configuration
digest, transport, protocol version, server identity, and available tools.
The required shape and acceptance checks are documented in
[`docs/preflight-inspector.md`](../../docs/preflight-inspector.md).

Long-running jobs expose one lifecycle:

`accepted → started → working → completed | failed | cancelled | timeout`

Progress is bounded by an absolute deadline. The runner emits a heartbeat at
approximately 15-second intervals (or sooner when state changes), including
the phase, elapsed time, deadline, and last activity timestamp. Progress never
extends the deadline. Client retries must reuse the same `request_id` and
configuration fingerprint so uncertain transport cannot duplicate dispatch.

## Data handling

Prompts, repository excerpts, tool results, and attachments sent to a
configured external model provider leave the local machine. Do not submit
credentials, private keys, protected health information, production-only
material, or unredacted customer data. Logs and job records must contain
digests, bounded summaries, and redacted diagnostics—not full prompts,
credentials, or payloads. Read [`docs/data-handling.md`](../../docs/data-handling.md)
before enabling an external provider.

## Grok Build controls

`grok_build` invokes `grok --no-auto-update -p <prompt> --cwd <target>
--output-format streaming-json` directly by default; the official `--single`
alias is equivalent to `-p`. Typed fields cover model,
output format, UUID session selection, resume/continue/fork, reasoning effort,
max turns, built-in sandbox profile, permission mode, rules, tool allow/deny lists,
repeatable permission rules, automatic approval, bounded JSON Schema structured
output, verbatim prompts, partial message streaming, and safe feature switches.
Prompt text is one argv value; raw arguments, shell strings, executable paths,
environment maps, provider URLs, prompt files, and system-prompt replacement
are not exposed.

`json_schema` accepts a JSON Schema object or boolean, is capped at 16 KiB after
serialization, and forces `output_format: "json"`. `include_partial_messages`
is accepted only with `streaming-messages-json`; `verbatim` is a boolean prompt
transport control.

Permission mode is role-dependent in the advertised MCP schema as well as at
runtime. Review and verify accept omitted `permission_mode`, plus the legacy
`default`/`plan` aliases and explicit `auto`, then normalize the effective
receipt and argv to Grok's noninteractive `auto` mode inside the hard
`read-only` sandbox. In that mode blocked tool calls fail back to the model;
the sandbox still blocks repository writes. Automatic approval, `no_plan`, and
write-capable allow rules are rejected. Headless implement runs omit the field
or use Grok's noninteractive `auto` permission mode inside the bounded
`workspace` sandbox because interactive approval modes can cancel edits when no
approval channel exists.
An implement run that exits without changing an allowed path is reported as a
contract/integrity failure, not a generic provider process failure. The
postflight Git scope verifier remains authoritative for `allowed_paths`.

Sandbox enforcement remains owned by the official Grok CLI ([built-in sandbox
profiles](https://docs.x.ai/build/features/sandbox)). The connector accepts
only Grok's built-in `off`, `workspace`, `devbox`, `read-only`, and
`strict` profiles, records the normalized profile in the effective
configuration, and passes it as the exact `--sandbox <profile>` argument. The
status summary reports `managed_by: "grok_cli"` and
`enforcement: "cli_managed"`; it does not guess at host-specific Landlock or
Seatbelt capabilities and does not attempt to emulate them. The connector
still verifies the configured executable with `grok --version` and records
actual process-start failures from the managed spawn.

The official CLI also provides ACP through `grok agent stdio`. The connector
uses ACP only for the Co-Engineer MCP `capacity` tool's read-only billing and exact session
usage calls. Coding dispatch stays on the documented direct headless prompt
interface; it is not routed through ACP and does not invent an ACP JSON-RPC
proxy. Prompt-file/prompt-JSON input, system-prompt overrides, debug files,
leader sockets, restore/worktree/ref controls, login/update commands,
interactive UI commands, and agent/agents bundle selection are intentionally
outside this release: each would bypass the target-bound prompt contract,
lifecycle ownership, or credential boundary.
Direct review and verify dispatch also rejects catch-all permission grants and
project-local Grok, Cursor/Claude compatibility, or MCP configuration before
provider startup; callers must use only explicit read-only tool rules and the
connector-owned configuration. Grok account-capacity probes run from the fixed
POSIX root rather than inheriting a repository working directory.
The connector keeps a fixed bounded streaming parser, so unbounded/raw output
schemas and provider-specific output contracts are not accepted.

The packaged pinned ACPX runtime, bounded ACP proxy/ledger/schema helpers, and
Grok Bubblewrap outer-runtime modules are conformance work only. They remain
unwired: this release exposes no public session tool, direct `grok_build`
continues to use the CLI-managed sandbox described above, and real
host/systemd acceptance is still pending. The experimental outer boundary does
not accept `XAI_API_KEY`; its credential design is an attested owner-only Grok
authentication file. Do not treat the presence of these packaged modules as
runtime readiness.

## Troubleshooting

- `missing_credential`: provide `MODEL_API_KEY` to the MCP process or set
  `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` to an owner-only file outside the
  checkout, then restart Codex so the MCP launcher inherits the change. Never
  put credentials in a tool call or commit them.
- Grok reports `unauthenticated`, `Not signed in`, or `grok models` fails:
  authenticate with the normal `grok login`/device flow, or provide
  `XAI_API_KEY` in the MCP process environment. Re-run `grok models` and
  restart Codex if the environment or home/session location changed. Provider
  sessions are reused but can expire or be revoked; the plugin cannot refresh
  them silently.
- `target_fingerprint_mismatch`: the checkout, Git HEAD, or directory identity
  changed after the target was prepared. Re-read the exact HEAD, use a clean
  checkout, and run the Co-Engineer MCP `preflight` tool again. Do not reuse a timed-out or cancelled
  checkout until its changes and taint have been inspected.
- `unconfigured_home`, `state_directory_unwritable`, or `EROFS`: set an
  absolute, owner-writable `CODEX_CO_ENGINEER_STATE_DIR`, or provide the
  host-provisioned absolute `CODEX_TASK_STATE_ROOT`; ensure the MCP process
  receives it and restart Codex. The plugin fails closed instead of falling
  back to a protected or ambiguous home directory.
- The plugin is installed but its tools or skills are missing: run
  `codex plugin list --json` and confirm `installed: true` and `enabled: true`,
  then fully restart the Codex App and start a fresh task. There is no
  `codex plugin reload` command; an existing task can retain a stale catalog.
- DSH status reports `unsupported_version`: the accepted adapter is
  DeepSeek Harness `0.1.0-rc.6`; verify `dsh --version` and configure the
  selected profile before retrying.

## Development

```bash
cd plugins/plumbob-harness-control
npm test
```

From the repository root, the release inventory check is:

```bash
node scripts/validate-release.mjs
```

Do not run provider-backed jobs in CI. Use fixture runners and local temporary
Git repositories for target, lifecycle, timeout, cancellation, and redaction
tests. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and
[`SECURITY.md`](../../SECURITY.md).
