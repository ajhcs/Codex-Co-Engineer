# Release process

The authoritative gate runs once against an exact clean local candidate:

```sh
release-gate plan --repo "$PWD"
release-gate run --repo "$PWD"
```

The gate checks Node 24 and MCP Inspector 2.2.0, validates the 3.x five-tool
surface, bootstraps the pinned ACPX source tree, runs the Co-Engineer tests and
provider-free Inspector smoke test, verifies ACPX reproducibility/provenance,
and inspects package inventories. It does not require provider credentials.

GitHub Actions mirrors the portable stages. It is diagnostic, not a replacement
for the exact-tree receipt.

After the provider-free gate passes:

1. Run `npm run setup:check` on the target host.
2. Run one bounded live acceptance task through Grok, Cursor Local, Cursor
   Cloud, and DSH.
3. Verify terminal receipts, zero active tasks, clean caller checkouts, and no
   abandoned provider run.
4. Inspect the packed payload and commit author metadata for personal data.
5. Open the release PR. Codex reviews and merges only after CI and independent
   provider review pass.

Live acceptance receipts stay local and must not contain credentials or raw
private repository content.
