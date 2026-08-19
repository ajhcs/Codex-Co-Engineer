# Configuration

Codex-Co-Engineer has no project configuration schema. Provider authentication
uses each provider's normal persistent login or owner-only key file.

| Variable | Purpose |
| --- | --- |
| `CODEX_CO_ENGINEER_STATE_DIR` | Absolute owner-only task state root. Defaults to the XDG state directory. |
| `CODEX_CO_ENGINEER_GROK_COMMAND` | Grok CLI executable. Defaults to `grok`. |
| `CODEX_CO_ENGINEER_CURSOR_COMMAND` | Cursor Local executable. Defaults to `cursor-agent`. |
| `CODEX_CO_ENGINEER_DSH_COMMAND` | DSH CLI fallback executable. Defaults to `dsh`. |
| `CODEX_CO_ENGINEER_ACPX_COMMAND` | ACPX executable used for DSH. Defaults to `acpx`. |
| `CODEX_CO_ENGINEER_DSH_ACP_COMMAND` | DSH ACP adapter executable. Defaults to `dsh-acp-demo`. |
| `CODEX_CO_ENGINEER_DSH_ACP_CONFIG` | Absolute DSH ACP YAML path. |
| `CODEX_CO_ENGINEER_MODEL_API_KEY_FILE` | Owner-only Muse/DSH model key file. |
| `CURSOR_API_KEY_FILE` | Owner-only Cursor Cloud API key file. |
| `MODEL_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY` | Optional process-level provider credentials. |

Run `npm run setup` in the plugin directory to install the pinned local
dependencies and create the DSH ACP configuration. Run
`npm run setup:check` for a read-only readiness report.

Repository paths, prompts, roles, deadlines, and PR intent are task inputs to
`delegate`; they are not global policy.
