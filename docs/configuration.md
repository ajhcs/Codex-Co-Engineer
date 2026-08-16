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
| `CODEX_CO_ENGINEER_RUNTIME_WORKSPACE` | DSH/Prime adapter workspace; not target authority. |
| `CODEX_CO_ENGINEER_ALLOWED_ROOTS` | Path-delimited administrator root allowlist. |
| `CODEX_CO_ENGINEER_STATE_DIR` | Owner-only SQLite, lifecycle, and redacted-log state. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Optional key file outside the clone. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH executable name or absolute path. |
| `CODEX_CO_ENGINEER_PRIME_COMMAND` | Optional Prime executable. |
| `CODEX_CO_ENGINEER_PRIME_AGENT_COMMAND` | Optional Prime Agent executable. |

Defaults follow `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and `PATH`; no public code
contains a personal home, workspace, or credential path.

