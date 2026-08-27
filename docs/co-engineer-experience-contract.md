# Co-Engineer experience contract

Give Codex a team of external co-engineers without giving up control.

This is the public-language contract later UX slices consume. It freezes
terminology, Codex speech, activation, the five-tool catalog, and the
one-submission coordination shape. It does not change runtime, README,
skill, manifest, marketplace, asset, version, changelog, or release
surfaces.

Owned files:

- `docs/co-engineer-experience-contract.md`
- `docs/co-engineer-user-journeys.md`
- `plugins/codex-co-engineer/test/r1-experience-contract.test.mjs`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-contract.json`
- `plugins/codex-co-engineer/test/fixtures/v3-experience-golden-prompts/**`
- this document

Normal users speak and read only the public language below. They never
need MCP JSON. They never see internal `Pxx`, `R-TRUTH`, or
`AttentionBatch` terms.

## Product lead

Exact sentence:

`Give Codex a team of external co-engineers without giving up control.`

Codex remains chief engineer, reviewer, and merge authority. External
co-engineers do isolated assigned work. The user keeps control.

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

This slice does not implement runtime, tools, README, skill, manifest,
marketplace, asset, version, changelog, release, Git remote, or
protected-ref behavior. It does not claim Gate A, credit economics, or
context-efficiency results.

## Testing

```
node --no-warnings --test test/r1-experience-contract.test.mjs
```
