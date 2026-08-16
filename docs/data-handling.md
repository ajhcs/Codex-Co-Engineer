# Data handling

Provider credentials are accepted only from the server environment or a
protected file outside the repository. They are never valid tool arguments.

Job records store prompt hashes and lengths, opaque summaries, canonical
configuration digests, and bounded diagnostics. The runner sanitizes exact
prompt fragments and credential-shaped strings before child output is written
to the connector log. Read APIs apply redaction again as defense in depth.

Do not submit credentials, private keys, protected health information,
production-only data, or unredacted customer payloads to an external model.
Provider-backed jobs are never run in CI.

Local state may still contain repository-derived model output. Keep the state
directory owner-only, apply retention appropriate to the repository, and do
not attach it wholesale to public issues.

