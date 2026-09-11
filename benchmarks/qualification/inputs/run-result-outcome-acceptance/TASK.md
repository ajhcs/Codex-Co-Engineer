# Run-result outcome and acceptance

This frozen case reproduces the 3131f9ac7f6807eccb2ab68f027f1d98d3db3661
run-result projector defects later corrected in the 3.4.3 candidate: completed
provider work was treated as Codex acceptance, failed/uncertain/unfinal states
collapsed, verify completion was promoted to a passed check, mixed heads were
described as one candidate, missing usage became zero, and an unbound
acceptance flag could label the result Accepted.

Repair `project-result.mjs` so the frozen checks in `project-result.test.mjs`
pass. Do not edit the test file, this prompt, or the recorded identity. Do not
copy later corrected sources into the workspace.

Required behavior:

- A completed provider job is not Codex acceptance. `codex_accepted` is true
  only when the assignment result is completed and a Codex acceptance record is
  bound to this run id and the exact candidate head.
- Failed, uncertain, and unfinal remain distinct. A failed run stays failed
  even when a lane completed and produced a head. Uncertain proof
  (lifecycle_pending, unknown dispatch confidence, dirty handoff) is not
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

Acceptance is the frozen command `node --test project-result.test.mjs`.
