# Model selection for Co-Engineer

Reviewed 2026-09-04. Choose one owner for the task. Add workers for bounded,
independent assignments when their benefit exceeds coordination overhead.
Co-Engineer delegates to external providers; native model selection and
reasoning effort belong to the host. Preserve user choices and stock defaults.

## Provider ownership comes first

When the user wants to use available external capacity, keep implementation,
technical review, and corrections with authorized Grok/Cursor/Muse owners where
their capabilities fit. A cheaper native agent still draws on the native pool;
adding a Luna/Sol relay does not by itself meet that objective. Keep final host
review and genuine escalation decisions with the host. See the
[autonomous ownership guide](autonomous-ownership.md).

## Practical task ladder

These job titles and effort thresholds are workflow heuristics, not official
OpenAI roles, benchmark rankings, or a requirement to climb every rung.

| Model | Useful starting assignment |
| --- | --- |
| Luna | Clearly specified, localized edits or repeatable work with straightforward checks |
| Terra | A bounded feature requiring reasonable local implementation decisions |
| Sol | Understand a subsystem and implement it with substantial engineering judgment |
| Astra Medium | Own difficult work spanning multiple subsystems |
| Astra High | Investigate substantial ambiguity, architecture, or a difficult failure |
| Astra XHigh / Max | Exceptionally difficult work where additional reasoning justifies its cost and latency |

Effort is a separate control within a model, not a seniority guarantee across
models. Astra also supports low; medium is not a mandatory minimum. Use only
effort values exposed by the host. Increase effort for reasoning difficulty;
missing evidence, access, or a reproduction needs tools or information first.
Do not exhaust cheaper models before choosing Astra for an evidently hard task.

## Official basis

OpenAI describes [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
as cost-focused, [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
as balancing intelligence and cost, [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
as a flagship for complex professional work, and
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) as its most
capable model for the hardest end-to-end work. These descriptions support the
broad ladder, not the exact assignment or effort boundaries above.

[Model selection guidance](https://developers.openai.com/api/docs/guides/model-selection)
prioritizes reaching a quality target, then reducing cost and latency while
preserving it. Establish that target with a capable model and representative
repository tasks. Compare accepted results, missed defects, rework, total
usage, and elapsed time before adopting a cheaper default. Sol High replacing
Astra for most tasks and a fixed Astra → Sol → Luna hierarchy remain unproven.

## Keep coordination small

The owner can implement, coordinate, and review. Sol Medium may coordinate
under Astra when a large set of independent assignments warrants it; skip
that extra layer otherwise. Choose Grok, Cursor, or DSH for the requested
provider or useful environment. Retain each worker's original lifecycle tools,
task identity, and evidence. Reconcile active work before replacing it.
[OpenAI orchestration guidance](https://developers.openai.com/api/docs/guides/agents/orchestration)
distinguishes helpers from ownership handoffs and recommends narrow specialist
jobs with short routing descriptions.

Keep routine launch instructions focused on the assignment, constraints, and
acceptance checks. Do not load this selection guide for an ordinary delegation.
Astra's async tools, steering, and cache-preserving reasoning updates require
host/API support; MCP schema fields cannot enable them. Preserve the existing
wait and reply contracts. See [Astra guidance](https://developers.openai.com/api/docs/guides/latest-model).
