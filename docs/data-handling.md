# Data handling

Provider credentials are accepted only from the server environment or a
protected file outside the repository. They are never valid tool arguments.
For `grok_build`, `MODEL_API_KEY` is not required or passed to the child;
Grok's OAuth/session state remains under the user's normal home and an
administrator may provide `XAI_API_KEY` through the daemon environment. The
official CLI is invoked directly with an argv vector, never through a shell.

Job records store prompt hashes and lengths, opaque summaries, canonical
configuration digests, and bounded diagnostics. The runner sanitizes exact
prompt fragments and credential-shaped strings before child output is written
to the connector log. Read APIs apply redaction again as defense in depth.

Do not submit credentials, private keys, protected health information,
production-only data, or unredacted customer payloads to an external model.
Provider-backed jobs are never run in CI.

Local state may still contain repository-derived model output. Keep the state
directory owner-only, apply retention appropriate to the repository, and do
not attach it wholesale to public issues.

Grok `streaming-json` (or `streaming-messages-json`) records are retained only
as bounded, redacted lifecycle logs. Unknown and incomplete future event types
are tolerated; explicit provider/agent error records and nonzero exits fail the
job. A typed JSON Schema object/boolean is capped at 16 KiB and forces JSON
output; arbitrary output contracts are not accepted. The ACP `grok agent stdio`
interface, prompt-file/prompt-JSON modes, system-prompt override, debug files,
leader sockets, restore/worktree/ref commands, agent/agents bundles, and
interactive login/update commands are not proxied by this release because they
would bypass the target, lifecycle, or credential contract. The adapter's
bounded parser owns the durable output contract.
