# Roadmap

Status: 3.4.3 is published with partial qualification. Measured benefit,
clean-agent onboarding, and refreshed native-host acceptance remain open.
See the [release notes](releases/v3.4.3.md) and [release requirements](release.md).

This roadmap distinguishes the **3.4.3 adoption and ownership package** from
later ideas. It is not a usage forecast, adoption claim, or endorsement.

## In scope for 3.4.3

| Theme | Intent |
| --- | --- |
| Ownership and deadlines | Finish complete external ownership through bounded correction, with truthful deadline and revision behavior. |
| Demonstrable outcomes | Make a reviewed candidate understandable: assignment outcome, changes, decisive checks, review state, and unresolved decisions. |
| Onboarding | A short first-success path: host compatibility, one chosen provider, and a tiny public example under `examples/first-outcome`. |
| Contribution and evaluation package | Issue forms, PR template, `SUPPORT.md`, welcoming contributor guide, starter tasks, frozen comparison cases and an offline analyzer that includes native helpers, corrections, and failed attempts. |

## Remaining qualification and showcase evidence

The [development case](demos/ownership-deadline.md) records actual implementation,
review, correction, and Codex acceptance of a specific fix. Complete the existing
gate and host acceptance before labeling a recording as a qualified-release demo.
Run fresh-user installation attempts and matched paid comparison cohorts with an
explicit evaluation budget; publish failures and missing measurements too.
See [showcase preparation](showcase.md) for the current local-MCP distribution route.

## Later (not this package)

These remain open design or later release work. They are **not** beginner
contributor tasks for 3.4.3:

- Broad graph or visual workflow editing UI
- Wide OS expansion beyond the current Linux/systemd/cgroup v2 local boundary
- Large multi-provider catalog expansion
- Automatic budget or subscription-balance routing
- Product analytics or predicted usage percentages

Compatibility experiments with other tools can be evaluated independently.
They should not be tightly coupled into this patch's qualification scope.

## Contribution guidance

Approachable starter work is listed in [contributor-tasks.md](contributor-tasks.md).
Complex provider integrations and cancellation-boundary redesigns need
maintainer guidance and should not be labeled beginner tasks.

Questions and reports use Issues today; see [SUPPORT.md](../SUPPORT.md).
Preserve the five-tool catalog (`status`, `delegate`, `task`, `tasks`,
`cancel`) and Codex as final review authority in any contribution.
