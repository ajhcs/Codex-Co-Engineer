# A real correction during Co-Engineer development

On September 10, 2026, Co-Engineer used external coding agents to build its next
ownership and deadline changes. This case records one completed engineering
loop from that work. It is a development record, not a staged terminal session
or a comparative benchmark.

## Implementation → independent review → correction → Codex acceptance

1. **Cursor implemented extensible ACP deadlines.** The active provider turn
   had an inner fixed timeout that could outlive the intent of the supervisor's
   recorded extension. The change made the supervisor's current deadline and
   cancellation signal govern the turn and retained timeout truth after
   partial output. Producer commit: `4e8460ee097f686c1ae804c3b5b651ecd8f321ec`;
   integrated as `d2c691f`.
2. **Codex reviewed the implementation independently.** A module-global
   active signal let concurrent ACP sessions replace each other's cancellation
   context. Late promise settlement also needed to remain observed. A passing
   single-session test would not establish correct concurrent behavior.
3. **The same external owner corrected the findings.** Cursor replaced the
   global signal with per-turn `AsyncLocalStorage`, handled late settlement,
   and added concurrent-session and pre-aborted-turn coverage. Producer commit:
   `43d9e79f229c93681cee7ee902f5ef233da51066`; integrated as `eed128c`.
4. **Codex accepted the correction into the development candidate.** Independent
   focused runtime checks passed 53/53; provenance and offline reproducibility
   checks passed 9/9. The checked vendor bundle reproduced byte for byte.
   This acceptance covers the deadline correction. It is not permission to
   publish, merge, or describe all of 3.4.3 as qualified.

The installed coordinator used for these jobs was 3.4.2. Correction was a fresh
explicit assignment tied to the completed producer. This record therefore
demonstrates the ownership practice and the resulting code; it does not alone
prove the new `task.revision` operation on an installed 3.4.3 host. Production
supervisor-path fixtures exercise that operation against actual Git worktrees.
The release procedure still requires native host acceptance.

## Retained observations

| Observation | Implementation | Correction |
| --- | --- | --- |
| Provider/model recorded by the task | Cursor Local / composer-1 | Cursor Local / composer-1 |
| Task created (UTC) | 21:00:53.867 | 21:18:13.966 |
| Task finished (UTC) | 21:13:40.920 | 21:22:00.620 |
| Created-to-finished duration | 767,053 ms | 226,654 ms |
| Reconciled terminal state | completed | completed |
| Process boundary / writer lock | inactive_empty / unlocked | inactive_empty / unlocked |
| Provider tokens and cost | unknown | unknown |
| Total native usage, including helpers | unknown | unknown |

Times come from durable task timestamps. They include startup and cleanup and
are not active model-compute times. These two jobs total 993,707 ms; their
overlapping parent task also included Grok work and other review activity.
Do not use this sum as total project elapsed time or a native-only counterfactual.

The original aggregate briefly reported a transport observation problem;
subsequent task inspection proved normal completion and cleanup. The provider
job was not replayed. A local sandbox initially prevented test subprocesses
from completing their ACP handshake; running the same checks with the required
host process support passed. Both recovery work and correction work belong in
any future cost comparison.

## Reproduce the code checks

From the candidate checkout, with Node.js 24 and its documented dependencies:

```sh
node --no-warnings --test \
  plugins/codex-co-engineer/test/acpx-runtime.test.mjs \
  plugins/codex-co-engineer/test/v3-acp-worker.test.mjs
npm --prefix tools/acpx-vendor run test:reproducible
```

These deterministic checks require local child-process support and no paid
provider. Their counts can grow with later regression coverage. The complete
[release gate](../release.md) is still authoritative for release qualification.
For a first external assignment use the [quickstart](../co-engineer-quickstart.md).
For quantitative comparisons use the [benchmark protocol](../../benchmarks/).

Raw task receipts remain private: they contain worktree locations and provider
output. This page intentionally records only the facts needed to examine the
engineering claim. Missing usage has not been filled with token estimates.
