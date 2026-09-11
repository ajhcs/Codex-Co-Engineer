# Run-result outcome and acceptance

This retrospective task uses a bounded pre-fix snapshot of public repository
source. Repair the historical modules at their original paths so the frozen
checks in `checks/run-result-outcome.test.mjs` pass.

Do not edit the check file, this prompt, or recorded identity. Do not copy
later corrected sources, Git history, or other trial outputs into the
workspace.

Required behavior:

- A completed provider job is not Codex acceptance. `codex_accepted` is true
  only when the assignment result is completed and a Codex acceptance record is
  bound to this run id and the exact candidate head.
- Failed, uncertain, and unfinal remain distinct. A failed run stays failed
  even when a lane completed and produced a head. Uncertain proof
  (`lifecycle_pending`, unknown dispatch confidence, dirty handoff) is not
  completed. A still-running lane keeps the result unfinal.
- Completed verify work is not a passed check. Checks stay empty unless an
  explicit check record is supplied.
- Independent lane heads are not one composed candidate. Report a candidate
  head only for a single lane or an explicit composed=true override.
- Missing metrics stay unknown. Do not emit numeric zero for absent usage.
- Shareable text must not leak owner-only prompts, worktree paths, or internal
  tokens such as `not_accepted`.
- Stale or unbound Codex acceptance cannot label the result Accepted. A bound
  acceptance still cannot accept a failed assignment result.

Acceptance is the frozen command
`node --test checks/run-result-outcome.test.mjs`.
