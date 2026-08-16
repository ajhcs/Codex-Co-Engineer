# Release process

1. Review the exact target and configuration digests.
2. Run `release-gate plan --repo "$PWD"`.
3. Run one authoritative `release-gate run` for the unchanged candidate.
4. Inspect the JSON receipt and package dry-run inventory.
5. Confirm ignored personal directories and credentials are absent.
6. Tag the manifest/package version and create the GitHub release.

The release gate runs dependency-free validation, the Node test suite, a real
MCP Inspector preflight, and an npm package inventory. A retry does not erase a
first-pass failure.

