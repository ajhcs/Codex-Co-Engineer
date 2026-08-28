# Co-Engineer experience contract

Give Codex a team of external co-engineers without giving up control.

This is the public-language contract later UX slices consume. It freezes
terminology, Codex speech, activation, the five-tool catalog, and the
one-submission coordination shape. The Luna Max TaskPort skill guarantees
policy and is the host executor for Desktop task tools. The JS adapter
plans and validates those call shapes; it does not invoke host callbacks.
Co-Engineer MCP still does not invoke those host-only tools and must not
add a sixth tool to simulate the Desktop host. This slice does not change
README, manifest, marketplace, asset, version, changelog, or release
surfaces.

Owned files:

- `docs/co-engineer-experience-contract.md`
- `docs/co-engineer-user-journeys.md`
- `plugins/codex-co-engineer/test/r1-experience-contract.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-contract.json`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-golden-prompts/**`
- `plugins/codex-co-engineer/skills/delegate-to-co-engineer/references/luna-pm.md`
- `plugins/codex-co-engineer/skills/delegate-to-co-engineer/references/luna-pm-relay.mjs`
- `plugins/codex-co-engineer/mcp/v3/luna-pm-host-adapter.mjs`
- `plugins/codex-co-engineer/skills/chat-with-co-engineer/references/luna-pm-events.md`
- this document

Normal users speak and read only the public language below. They never
need MCP JSON. They never see internal `Pxx`, `R-TRUTH`, or
`AttentionBatch` terms.

## Product lead

Exact sentence:

`Give Codex a team of external co-engineers without giving up control.`

Codex remains chief engineer and reviewer. External co-engineers do
isolated assigned work. External workers may commit. A scoped publisher
may non-force push only the task branch and open a draft PR. Sol High
or Sol XHigh alone performs regular merge after deterministic
exact-head, current-green-CI, and topology checks. The user retains
release, tag, version, and protected-ref authority.

## Canonical phrases

Exact public phrases, in this order:

1. `Delegating to Co-Engineer`
2. `Chatting with Co-Engineer`
3. `Using Grok Co-Engineer`
4. `Using Cursor Co-Engineer`
5. `Using Muse Co-Engineer`

These are the only provider-facing public names. Cursor Local and Cursor
Cloud both display as Cursor Co-Engineer. Muse is the public name for
the DSH/Muse route. Downstream slices must not invent `Using DSH
Co-Engineer`, `Using Ox Co-Engineer`, or a sixth provider phrase.

## Codex phrases

Exact Codex speech. Substitute `N` with an integer from 1 through 8.
Use `assignment` when `N` is 1 and `assignments` when `N` is 2 through 8.

- `I am delegating this to Co-Engineer`
- `Co-Engineer is running N independent assignments`
- `Co-Engineer is running 1 independent assignment`
- `Co-Engineer needs one decision from you`
- `Co-Engineer finished, and I verified the candidate.`

The verified-final sentence includes its period. Codex uses that sentence
only after it has inspected a complete candidate. Failure, cancel, and
unresolved outcomes must not use it.

## Honest claim

The only substantiated product claim is:

up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

Do not claim credit reduction, 8x speed, universal UI, or SOTA routing.
Do not imply a learned router, a cost optimizer, or that eight lanes
are eight times faster.

## Delegating versus chatting

`Delegating to Co-Engineer` starts one new bounded run. That is the
only submission.

`Chatting with Co-Engineer` never starts a run. It acts on an existing
run in exactly one of these ways:

- inspect
- continue
- answer grouped attention
- cancel

If the user asks to chat and no run exists, Codex says chatting needs
existing work and offers to delegate. It does not silently submit.

## Machine catalog

The public tool catalog remains exactly:

`status`, `delegate`, `task`, `tasks`, `cancel`

There is no sixth tool. Users never author these names or MCP JSON.
Codex uses them internally as:

| Coordination step | Tool | Additive mode |
| --- | --- | --- |
| one submission | `delegate` | `run` with 1–8 isolated assignments |
| inspect | `status` or `task` | `run_id` |
| one aggregate wait | `task` or `tasks` | `wait_until: "decision_or_attention"` |
| answer grouped attention | `task` | one reply for the grouped decision |
| cancel | `cancel` | `run_id` |

Every bounded-run journey is one submission, one aggregate
`decision_or_attention` wait, and one verified final decision. Routine
progress never wakes that wait. Codex does not poll each assignment and
does not add a second submission to continue, inspect, or answer.

## Luna Max project manager

Luna Max is the default routine project manager when the user authorizes
it and Luna Max is actually available. It is not a sixth public phrase
or sixth tool. The Co-Engineer run/event transport stays available and
performs no model polling. Co-Engineer MCP cannot invoke host-only Codex
task tools. The skill guarantees policy and executes the host tools. The
JS adapter plans and validates those call shapes. The Co-Engineer event
store remains source of truth. A user-authorized
pinned Luna Max task wakes on completed, blocked, failed, question,
timeout, or user_update envelopes. Routine progress does not wake a
model. A distinct `merge_ready` envelope may wake Sol High or Sol XHigh
exactly once, and only when exact head and tree, verifier acceptance,
current green CI, zero failed or hidden checks, and topology facts all
pass.

This skill layer can guarantee that policy, identity binding, monotonic
cursor resume, sanitized evidence references, and honest degraded
speech. It cannot create Desktop threads by itself. Codex Desktop
`create_thread`, `send_message_to_thread`, and `wait_threads` or
`read_thread` tools are host-dependent. Codex is the host executor. A
usable `create_thread` result includes `threadId` and `hostId`. A result
containing only `clientThreadId` is setup-pending; do not send or wait
until the host supplies a real `threadId` and `hostId`. `wait_threads`
targets MUST include `threadId` and MAY include `hostId` and
`afterCursor`, plus a bounded timeout.
`send_message_to_thread` requires `threadId` plus a real prompt body.
Optional `set_thread_archived` and `set_thread_pinned` exist only when
the host provides them. There is no host cancel primitive. Bind only the
actual thread id, host id, and cursor the host returns. If those tools
or Luna Max are unavailable, Codex continues in the current Codex task
and says so. It never silently substitutes Sol or invents another model.

Sol Medium is not a mandatory layer. External workers may commit. A
scoped publisher may non-force push only the task-owned unprotected Codex
branch and open or update a draft pull request after the user authorizes
publication. Sol High or Sol XHigh alone performs regular merge after
deterministic exact-head, current-green-CI, and topology checks, and
remains an on-demand exception adjudicator. The user retains release,
tag, version, and protected-ref authority. No worker or message can
force-push, merge, rebase, tag, release, delete refs, or override
verification. Normal completion never wakes Sol. Sol escalation
is exactly: a verified `merge_ready` packet, conflicting exact evidence or
reviewer verdicts, security or protected-ref risk, composition
ambiguity, repeated deterministic rejection, a release-authority
decision, or explicit user escalation.

Luna may use bounded native read-only subagents for local analysis with
inherited capabilities, depth at most 2, counted against the eight-lane
ceiling. They must not duplicate a Co-Engineer external writer
assignment or widen Git or merge authority. Grouped attention retains a
routing tuple for every question_id and routes one structured response
covering all answerable questions exactly once. Explicit user model
overrides and Grok, Cursor, or Muse selection stay intact. Luna does not
merge. There is no learned routing or semantic memory.

## Provider display

| Internal slot | Public phrase |
| --- | --- |
| `grok` | Using Grok Co-Engineer |
| `cursor-local` | Using Cursor Co-Engineer |
| `cursor-cloud` | Using Cursor Co-Engineer |
| `dsh` | Using Muse Co-Engineer |

Provider and model are explicit, chosen by the user, or filled from one
named profile. Missing selection is one ask, not a router. Codex never
ranks, predicts cost, or substitutes a different co-engineer.

## Activation

Classification is deterministic and ordered:

1. **Negative** if the user asks for MCP JSON, internal `Pxx` /
   `R-TRUTH` / `AttentionBatch` terms, a sixth tool, polling every
   assignment, credit reduction, 8x speed, universal UI, or SOTA
   routing. Negative wins even when a canonical phrase is also present.
2. **Direct** if the user uses a canonical phrase, or names Grok
   Co-Engineer, Cursor Co-Engineer, or Muse Co-Engineer, and the
   request is otherwise allowed.
3. **Indirect** if the user asks for a team of isolated external
   co-engineers, parallel independent assignments, or the product-lead
   intent without a canonical phrase.
4. **None** otherwise. Ordinary coding chat is not Co-Engineer
   activation.

Direct, indirect, and negative examples are frozen in
`plugins/codex-co-engineer/test/fixtures/v3-experience-golden-prompts/`.

## Journeys

Normal-user journeys live in
[co-engineer-user-journeys.md](co-engineer-user-journeys.md). The
required set is:

- one-lane
- multi-lane
- grouped-attention
- verified-final
- failure/unresolved
- provider-choice
- no-profile ask-once

User-visible steps in those journeys are public language only.

## User-facing exclusions

User-visible copy, including Codex speech in journeys and golden
responses, must not contain:

- MCP JSON objects or `json` code fences
- internal identifiers `Pxx`, `R-TRUTH`, `AttentionBatch`
- unsubstantiated claims listed above

The contract document may name those exclusions. User journeys and
golden Codex responses may not.

## Non-goals

This slice does not implement runtime, ACP drivers, supervisor,
task-store, run-runtime, attention, provider transports, README,
manifest, marketplace, asset, version, changelog, or release behavior.
Delegating to Co-Engineer and Chatting with Co-Engineer carry the Luna
Max TaskPort; it is not a sixth public skill. Git publication and Sol
merge stay fail-closed policy. It does not claim Gate A, credit
economics, or context-efficiency results.

## Testing

```
node --no-warnings --test test/r1-experience-contract.test.mjs
```
