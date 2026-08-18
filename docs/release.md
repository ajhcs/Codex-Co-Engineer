# Release process

The authoritative release gate is `local-exact-tree`. Run it once from a
dedicated clean worktree containing exactly the candidate files; unrelated
untracked files must be excluded from that worktree before the gate starts.
Do not use a general dirty checkout as the release candidate.

```sh
release-gate plan --repo "$PWD"
release-gate run --repo "$PWD"
```

The GitHub Actions job mirrors the portable stages for diagnostics, but is
non-authoritative because this repository does not install the `release-gate`
CLI there and GitHub's stock Bubblewrap does not provide the attested
fd-bind-capable host boundary. CI therefore does not simulate the
`release-prerequisites` or strict real-Bubblewrap stages. Its result cannot
replace the local receipt.

The declared stages run once, in this order:

1. Admit the host with a provider-free Linux/Bubblewrap check. The
   prerequisite exercises the production-shaped `--unshare-all --share-net
   --disable-userns --assert-userns-disabled` boundary, a synthetic tmpfs
   root, and inherited fd-backed mounts. It does not invoke a provider or
   infer network behavior from procfs routing state. Missing or unusable host
   capabilities are `environment_blocked` before any provider work.
2. Validate the candidate's critical files, exact versions, ACPX lock/manifest
   pins, checked-in asset hash, Node major 24, and Inspector 2.2.0 admission.
3. Bootstrap `tools/acpx-vendor` with the exact lock using
   `npm ci --ignore-scripts --no-audit --no-fund`.
4. Run the Co-Engineer unit suite, Cursor suite, and ACPX fake provenance unit.
5. Run the activation fixture and the strict real-Bubblewrap outer test with
   `GROK_OUTER_REQUIRE_REAL=1`. These tests use fake/local fixtures and make no
   provider or network calls.
6. Run both Inspector preflights with the globally installed, pinned
   `@modelcontextprotocol/inspector@2.2.0`.
7. Run exactly one build-kind stage:
   `npm --prefix tools/acpx-vendor run test:reproducible`. It performs one
   clean build and compares the result byte-for-byte with the checked-in ACPX
   assets.
8. Run the live `verify:publish-provenance` security stage. Its registry
   metadata, attestation, and npm signature checks use bounded live
   registry/TUF network requests.
9. Produce offline JSON dry-run inventories for the Co-Engineer and Cursor
   packages only, using explicit `./` paths and
   `--dry-run --ignore-scripts --offline --json`.

All install and reproducible-build stages receive the fixed absolute
`/tmp/codex-acpx-release-npm-cache` through stage environment. The bootstrap
may populate this cache; the reproducible build and the clean install that
precedes the signature audit consume it offline. The signature audit itself
uses bounded live TUF/registry network access, so unavailable public metadata
is an environment limitation while a mismatched signature/provenance is a
candidate failure. No provider credential is needed for the release gate. A
retry is a new receipt and does not erase a first-pass failure.

Review the JSON receipt and both package inventories before tagging the already
validated manifest/package versions. Do not bump versions as part of a gate
repair.
