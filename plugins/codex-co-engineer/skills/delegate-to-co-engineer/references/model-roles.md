# Model roles for Co-Engineer

Reviewed 2026-09-04. These are optional workflow recommendations for new work. Co-Engineer
does not configure the parent model or launch OpenAI models through `delegate`.
Select available models and supported effort values through the host's native
agent controls. Keep explicit user choices; do not rewrite global configuration.

## Suggested routing

| Role | Starting candidate | Responsibility |
| --- | --- | --- |
| Chief engineer for difficult work | GPT-6 Astra | Resolve architecture and ambiguity, reconcile conflicting evidence, accept the integrated result |
| Coordinator under a chief | GPT-5.6 Sol, medium | Divide independent assignments, track dependencies and receipts, integrate verified work |
| Combined chief/coordinator for ordinary work | GPT-5.6 Sol, high | A candidate when one coordinator can own the problem end to end |
| Bounded native worker | GPT-5.6 Luna | Localized implementation, exploration, or review with explicit acceptance checks |
| Provider worker | Grok, Cursor Local/Cloud, or DSH | Work requiring the selected provider's environment or capabilities |

Luna Max remains an option when requested and justified by results; it is not
the universal coordinator. An extra Sol layer is useful only when it reduces
the chief's coordination work enough to justify its added latency and context.
Skip it for small tasks or tightly coupled changes. Native subagents and MCP
provider workers have different lifecycle tools; keep each task on its original
control path and retain its task ID, branch, and evidence references.

## Evidence and uncertainty

OpenAI positions Astra for its hardest work. Its guide reports lower estimated
cost per task in several evaluations despite higher token prices. This does
not prove a particular Co-Engineer hierarchy wins on cost or quality.
[Astra guidance](https://developers.openai.com/api/docs/guides/latest-model).

The GPT-5.6 guide recommends medium as a balanced starting point and higher
effort when measured quality improves. It does not establish Sol High as an
Astra replacement for most repository tasks.
[GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6).

The comparison page lists Astra input/output at $10/$50 per million tokens
and Sol at $4/$20. These are API rates, not Codex subscription usage rates;
retries, reasoning, caching, and all workers affect actual task cost.
[Model comparison](https://developers.openai.com/api/docs/models/compare).

No controlled user-experience comparison has been established by this change.
Treat the routing table as a hypothesis until representative runs support it.

## Evaluate before making a default

Compare Sol Medium, Sol High, and Astra as coordinators against the previous
Luna Max baseline. Separately compare Astra alone with Astra plus Sol Medium
to measure the value of the extra layer. Hold worker assignments, repository
revision, tools, permissions, prompts, and acceptance checks constant.

Use recurring user failures alongside a small fix, a cross-file refactor, an
ambiguous debugging task, and a review with known defects. Repeat tasks to expose
variance. Record accepted-result rate, missed defects, rework, wall time,
clarification pauses, and total usage across the whole agent tree. Record
unavailable usage as unknown; do not estimate savings from response length.

Choose the least costly configuration that meets the same acceptance bar.
Escalate unresolved architecture or conflicting reviews to the chief with the
failed check, current diff, and attempted fixes. Reconcile an active worker
before replacing it. Provider success alone must not decide the winner.

## Feature boundaries

Astra adds asynchronous tools, mid-turn steering, and cache-preserving reasoning
updates in the Responses API. Those require host support. This plugin remains
a stdio MCP supervisor; adding API-only fields to its schemas cannot enable
them. Use host-provided concurrency with the existing durable wait and reply
contracts. Prompting adjustments should clarify autonomy, delegation, scope,
and verification without duplicating the host's full system prompt.
[Astra feature and prompting guidance](https://developers.openai.com/api/docs/guides/latest-model).
