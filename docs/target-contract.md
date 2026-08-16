# Target contract

Every dispatch names exactly one versioned target. Omitted and `null` targets
are invalid. `mode: "default"` is an explicit selection of the configured
runtime workspace; it is never an error fallback.

An explicit target contains absolute `working_directory` and
`expected_git_root` paths, the exact 40-character Git `HEAD`, relative
`allowed_paths`, and a `review`, `verify`, or `implement` role. Resolution
rejects symlinks, a cwd outside the Git root, HEAD drift, unknown fields, and
administrator-allowlist violations before credentials, deduplication, or
process startup.

The target fingerprint is SHA-256 over canonical JSON containing the resolved
workspace, cwd, Git common directory, exact HEAD, and filesystem device/inode
identity. The caller computes or records this value independently and sends it
as `expected_target_fingerprint`. A mismatch is fatal.

Prompts are task content only. A prompt-level `cd`, path, or claimed HEAD never
changes target authority.

This same contract applies to `grok_build`: the target cwd is passed as
`--cwd`, the target preamble is included in the task prompt, and Grok's
filesystem/permission settings cannot replace the connector's final Git scope
verification. Review and verify are read-only; implement jobs may emit a patch
only when every changed path remains under `allowed_paths`.
