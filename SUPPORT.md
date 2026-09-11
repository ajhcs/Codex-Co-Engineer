# Support

Thanks for using Codex-Co-Engineer. This page explains where to ask for help and what makes a report useful.

## Where to ask

| Need | Where |
| --- | --- |
| Bug or unexpected behavior | [Bug report](https://github.com/ajhcs/Codex-Co-Engineer/issues/new?template=bug.yml) |
| Feature or improvement idea | [Feature or improvement](https://github.com/ajhcs/Codex-Co-Engineer/issues/new?template=feature.yml) |
| Usage question or clarification | [Question](https://github.com/ajhcs/Codex-Co-Engineer/issues/new?template=question.yml) |
| Undisclosed vulnerability | Private [Security](https://github.com/ajhcs/Codex-Co-Engineer/security/advisories/new) route ([SECURITY.md](SECURITY.md)) |

GitHub Discussions is **not** enabled on this repository. Questions use Issues until maintainers enable Discussions and update this page.

Maintainers reply when they can; there is no promised response time.

## What helps

- What you tried and what happened (required for bugs).
- Optional version, host, and provider.
- Optional short reproduction notes with synthetic or redacted data.
- Optional sanitized excerpts only—never credentials, private paths, full private prompts, or private repository contents.

A confused first-time setup report is welcome. You do not need a diagnosis.

## Before opening an issue

1. Skim [troubleshooting](docs/co-engineer-troubleshooting.md) and the [quickstart](docs/co-engineer-quickstart.md).
2. Confirm host prerequisites for local workers when relevant: Linux, `systemd --user`, `systemd-run` 244+, unified cgroup v2, Node.js 24+, and Python 3.11+ for bundled setup.
3. Prefer the focused fixture checks in [CONTRIBUTING.md](CONTRIBUTING.md) when validating a documentation or code change.

## Contributing

Documentation, examples, compatibility reports, reproductions, tests, and code are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [contributor tasks](docs/contributor-tasks.md), and the [roadmap](docs/roadmap.md).
