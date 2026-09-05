# Native run lifecycle design

Status: implemented for 3.4.2; fresh Desktop acceptance follows installation.

## Evidence

Native MCP consent and Cursor dispatch work. A run inspection supplied nested lane identity to a supervisor callback expecting a top-level task ID. The run then finalized a partial handoff while its actual provider task continued and eventually completed. Provider text is not carried through the run result. Routine run waits also poll and persist at 50 ms intervals. Existing supervisor integration tests replace these production callbacks and consequently miss their contracts.

## Ownership

The task supervisor owns provider process/session identity, execution state, deadlines, cancellation, and provider output. The run owns immutable assignment bindings, consent/admission barriers, and an aggregate view over those tasks. The public adapter projects that view; it must not invent acceptance or lifecycle outcomes. Codex owns final review and integration.

Keep the established task runtime and the compatibility full-run path. Correct the semantic run boundary coherently rather than replace the provider implementations or introduce another scheduler.

## Decisions

1. Give every task-facing lifecycle operation one explicit identity context. Inspect, reconnect, reply, cancel, and result retrieval must reference the same bound task. Test the production bridge using task-store fixtures, not overridden inspect/reconnect/cancel callbacks.
2. Observation failure is uncertainty, not proof of provider termination. Preserve the ability to inspect and cancel that task; reconcile on a later request without replaying its prompt. Never report a terminal run while an owned optional or required provider task is still active or unconfirmed.
3. Preserve provider results durably and return a sanitized, bounded result on the normal run receipt. Use the existing exact task ID for any expanded diagnostics. Ordinary completion must not require reverse engineering the underlying task store.
4. Reuse task-store event waits. Do not write or increment run revisions for unchanged observations. Status remains immediate; waits wake for the requested progress, decision, terminal state, deadline, or caller cancellation.
5. Separate completed work from accepted or verified work. Required cancellation/failure blocks success. A partial handoff is evidence for review, not proof of successful verification. Presentation uses the same lifecycle meanings as admission, including unresolved observations.
6. Make tool metadata explain the native run workflow first; retain supported legacy inputs. Include useful titles, honest annotations, structured output schemas, and short cross-tool server instructions. Skills describe the workflow; the server owns execution and authorization.

The production bridge also sends the existing compiled child envelope and pins
managed workspaces to its recorded commit. Unsupported model overrides fail
before launch; configured provider defaults are not represented as model
attestation. No new scheduler, dependency, or permission framework is added.

## Acceptance

- A native semantic submission completes through the same run ID and returns provider output.
- Inspect/reconnect/cancel operate on the actual bound task IDs across restart.
- A temporary inspection error can recover to the actual final task state without dispatch duplication.
- Required failure/cancellation cannot become verified success; optional live tasks remain owned and cancellable.
- Stable status means stable cursor and no routine persistence; event waits do not hot-poll.
- Results remain bounded and sanitized; old saved runs and legacy task calls remain usable.
- Tests exercise real production adapters with fake task/process boundaries. The release gate is necessary; a separate opt-in host flow establishes app behavior.

## Official guidance

- https://developers.openai.com/plugins/concepts/plugins — smallest useful plugin shape; optional UI; headless operation.
- https://developers.openai.com/plugins/build/mcp-server — focused tools, schemas, annotations, stable IDs, useful structured results, and compatibility.
- https://developers.openai.com/plugins/build/skills — concise workflow guidance; server-owned authorization and execution.
- https://developers.openai.com/codex/mcp — local stdio is supported; server instructions describe cross-tool workflows. Public ChatGPT HTTP deployment requirements do not require replacing this local Codex transport.
