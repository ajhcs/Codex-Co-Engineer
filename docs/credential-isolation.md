# Credential and remote-mutation isolation (P29)

Status: implemented as an additive v3 boundary
Complements: [threat model](threat-model.md), [ADR 0001](adr/0001-r1-bounded-run-architecture.md), P23 provider registry, P28 Git authority policy

P29 is the credential and remote-mutation isolation boundary. It does not
sandbox a selected provider, substitute for P23 composition, or replace P28
policy. Same-UID malicious filesystem access is outside this non-sandboxed
boundary. P30 live protected-ref audit remains later work.

## Closed environment projection

Supervisor launch and readiness children receive a **closed**
provider/operation environment. Projection starts empty and copies only
allowlisted operational keys plus the selected provider's required route.
It does not enumerate caller objects, so hostile getters on unrelated keys
never run.

The following never reach provider or readiness children:

- Git, SSH, and hosting credentials (`GIT_*` except a small hardening set,
  `SSH_*`, `GH_TOKEN` / `GITHUB_*` / GitLab / Bitbucket tokens, askpass,
  `insteadOf`, push URLs);
- control tokens (`WORKTREE_BOOTSTRAP_*`, MCP/supervisor lock secrets,
  state-root tokens);
- owner-only key-file **paths** (`*_API_KEY_FILE` and Co-Engineer file
  pointers);
- unrelated ambient secrets and `NODE_OPTIONS` / `NODE_PATH`.

Lane hardening always sets `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`,
and `GIT_PUSH_OPTION_COUNT=0`. That is not a git sandbox; it removes the
platform's push/credential-helper environment.

## Provider route isolation

| Route | Receives | Does not receive |
| --- | --- | --- |
| Grok | `XAI_API_KEY` when present, Grok command, operational keys | Muse/Ox/Cursor keys, Git/SSH/hosting, key-file paths |
| Cursor Local | Cursor command, operational keys (CLI session under `HOME`) | `CURSOR_API_KEY`, Muse/Ox/Grok keys |
| DSH Muse | `MODEL_API_KEY`, Muse config path, DSH/ACPX commands | `OPENROUTER_API_KEY`, Grok/Cursor keys |
| DSH Ox | `OPENROUTER_API_KEY`, Ox config path, DSH/ACPX commands | `MODEL_API_KEY`, Grok/Cursor keys |
| Cursor Cloud local SDK | `CURSOR_API_KEY` plus bounded repository/ref/prompt data | Other provider keys, Git/SSH/hosting, key-file paths |
| Cursor Cloud remote | Credential-free origin URL, pinned SHA, prompt, optional `create_pr` flag | Local credentials, SSH agent, hosting tokens, key files |

Readiness probes use the same closed maps. DSH `--version` / `which` and
`npm root --global` do not inherit ambient secrets. Credential presence for
DSH and Cursor Cloud is checked by an in-process owner-only file read, not
by leaking the value into an unrelated child.

## Credential file reads

Credential values may come from the selected env key or from an owner-only
file. File reads require:

- an absolute, normalized path;
- `O_NOFOLLOW|O_RDONLY|O_NONBLOCK` open of a regular file;
- owner equal to the effective UID;
- mode `0600` (no group/other bits);
- link count 1 (hardlinks denied);
- size in `1..=16 KiB`;
- a post-read `fstat` identity match (dev/ino/mode/nlink/uid/size/mtime/ctime).

Errors are content-free: they never echo the path, the bytes, or the
credential. Symlink, FIFO, directory, oversize, empty, owner, mode, and
in-place swap during read fail closed. Same-UID replacement of a path
between checks is the documented non-sandbox residual.

## systemd-run argv handoff

Credential values never appear in `systemd-run` argv. Non-secret projected
keys may use `--setenv`. Secret keys are written to a bounded owner-only
no-follow regular file under `XDG_RUNTIME_DIR` (else the process temp
dir), mode `0600`, directory `0700`, and the service command is wrapped by
`credential-handoff-loader.mjs`.

The loader opens the file with the same no-follow rules, applies the
values, unlinks the file (and best-effort the directory), then runs the
original command as a child. The loader stays the service leader so
`KillMode=control-group` still reaches descendants.

Cleanup unlinks any remaining handoff file after spawn failure, cancel,
terminal stop, or a later restart (a restart creates a new file). The
short-lived `systemd-run` client receives only the D-Bus session keys
needed to talk to the user manager (`DBUS_SESSION_BUS_ADDRESS`,
`XDG_RUNTIME_DIR`, `XDG_SESSION_ID`).

Cursor Cloud workers are local Node processes, not systemd services; they
still receive the closed projection and never put secrets in argv.

## Exact-value redaction

ACP events, public errors, worker logs, and Cursor Cloud receipts redact
the exact credential values for the selected route, including 16 KiB
secrets split across events. Redaction uses the full value plus overlapping
32-byte fragments so a chunked log line cannot reassemble the secret.
Pattern redaction for common token shapes remains as defense in depth.

## No worker remote-mutation authority

Workers do not receive push URLs, credential helpers, or hosting tokens.
Profiles and manifests stay data-only. This boundary denies worker
push/merge/rebase/PR/tag/release/protected-ref/credential-helper/remote
mutation rather than performing those Git operations. P28 remains the
authority-policy seam; P29 does not wrap it and does not audit live refs
(P30).

Cursor Cloud `create_pr` stays a supervisor-to-remote SDK option. It is
not merge authority, does not send local Git/SSH/hosting credentials, and
does not grant workers a push URL.

## Compatibility

P23 `provider-registry.mjs` remains the only composition authority for the
four accepted adapters. P29 does not add a fifth slot, a wrapper factory,
or ambient discovery. P28 `git-authority.mjs` remains policy at the
authority seam; P29 consults its denied-operation vocabulary without
mutating Git. 3.2.1 Muse/Ox credential routing (one route never substitutes
the other) is preserved.
