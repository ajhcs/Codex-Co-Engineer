# Configuration

Codex-Co-Engineer validates two versioned schemas:

- operation configuration: `codex-co-engineer.config.v1`
- target configuration: `codex-co-engineer.target.v1`

Unknown fields are rejected. Runtime installation paths and credentials come
from environment variables; target authority always comes from the strict tool
input. Portable `CODEX_CO_ENGINEER_*` names are preferred. Legacy
`PLUMBOB_HARNESS_*` names remain compatibility aliases.

| Variable | Purpose |
| --- | --- |
| `DSH_HOME` | Optional absolute DeepSeek Harness profile/state home. When omitted, Co-Engineer uses `dsh-home` beneath the configured state directory and never falls back to the protected per-user DSH home. |
| `CODEX_CO_ENGINEER_DSH_HOME` | Preferred explicit absolute DSH profile/state home; relative paths fail closed. |
| `CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` | Default Git workspace used only by an explicit `target_context.mode: "default"`; not prompt authority. |
| `CODEX_CO_ENGINEER_ALLOWED_ROOTS` | Path-delimited administrator root allowlist. |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only SQLite, lifecycle, redacted-log state, and the default managed DSH profile/state root. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Optional key file outside the clone. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH executable name or absolute path. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Direct official Grok executable; defaults to `grok` and is passed without a shell. |
| `XAI_API_KEY` | Optional xAI API key consumed by the official Grok CLI. OAuth/session state is owned by Grok under the normal user home. |

Defaults follow `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `PATH`; no public code
contains a personal home, workspace, or credential path. The adapter fails
closed when the resolved state/DSH root is not writable, so a sandbox cannot
silently fall back to `~/.dsh` and surface a later `EROFS` profile error.

DeepSeek Harness is invoked directly in the attested target working directory.
Co-Engineer does not generate or rewrite an MCP backend patch and has no
dependency on an evaluation lab or another coding-agent runtime. Configure the
provider and any DeepSeek plugins through the selected DSH profile before
starting Codex.

`grok_build` does not call `requireCredential()` for `MODEL_API_KEY`. The
official CLI owns OAuth/session state; use `grok login` or device auth outside
the MCP request, or set `XAI_API_KEY` in the daemon process environment. The
daemon allowlist carries only this process-level credential and the explicit
`CODEX_CO_ENGINEER_GROK_COMMAND`; no MCP field can set an executable, provider
URL, environment map, or credential.
