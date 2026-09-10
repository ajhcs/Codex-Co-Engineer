# OpenAI showcase preparation

Status: a development case study and submission draft for the 3.4.3 candidate.
This is not a published release, submitted listing, or claim of OpenAI endorsement.

## The story

**Give Codex a team. Your other coding agents implement, test, and revise;
Codex reviews the result.**

Co-Engineer lets a Codex task use supported Grok and Cursor agents, and Muse
through OpenRouter, for bounded engineering assignments. Billing follows each
provider route; Cloud and API routes do not imply local subscription usage. External agents own implementation and fixes.
Codex handles the consequential decisions: selecting useful assignments,
reviewing the exact candidate, resolving conflicting findings, and accepting
the result. Durable workspaces and concise evidence keep that work inspectable.

The development of this upgrade is the first case study. Review of a real
deadline implementation found a concurrent-session cancellation defect. The
external implementation owner corrected it, and Codex independently checked
the result. See the [recorded development case](demos/ownership-deadline.md).
This establishes a useful engineering outcome; it does not establish a
subscription saving or a measured advantage over native Codex helpers.

## Materials for a submission

- Public [repository](https://github.com/ajhcs/Codex-Co-Engineer), supported-host
  [quickstart](co-engineer-quickstart.md), and [first outcome](../examples/first-outcome/).
- The recorded case, exact candidate identity, independent checks, and an
  explanation of what remains unknown in the [result report](run-results.md).
- A [comparison protocol](../benchmarks/) that counts native helpers,
  corrections, and failed attempts. Publish matched trials only after running
  them with an explicit evaluation budget; fixture data is not a benchmark result.
- [Support](../SUPPORT.md), [contributor tasks](contributor-tasks.md), and a
  [roadmap](roadmap.md) that welcome reproductions and counterexamples.

Before representing the candidate as a released product, complete the existing
[release requirements](release.md). Record actual use through the qualified
host: assignment, implementation, independent review, useful findings,
correction, and Codex's checked acceptance. Keep original elapsed times on
screen, label time compression, and redact private repository content and
account information. The README hero remains a conceptual illustration.
A development evidence walkthrough must not be labeled a recording of the
qualified release.

## Distribution and OpenAI route

OpenAI's [community page](https://developers.openai.com/community) offers a
developer-showcase route for projects, demonstrations, and workflows. Prepare
the materials above for that conversation; appearing there is not guaranteed.

The [plugin submission documentation](https://developers.openai.com/plugins/deploy/submission)
currently describes skills-only and remote MCP submissions. Local MCP developers
who cannot offer the required public HTTPS endpoint are directed to their
OpenAI contact. Checked September 10, 2026. Co-Engineer's local supervisor
therefore needs an appropriate local-plugin review/distribution conversation.
Keep repository-marketplace installation available. Changing a local process
supervisor into a public service is separate architecture work, not a patch
release shortcut to portal eligibility.

No listing, message, or showcase submission is sent by preparing these files.
