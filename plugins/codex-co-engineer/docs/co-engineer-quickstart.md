# Co-Engineer quickstart

Give Codex a team of external co-engineers without giving up control.

Start with **compatibility**, then **one chosen provider**, then one useful
first outcome. Speak in ordinary language. You do not write tool payloads.

## 1. Confirm the host

Local Grok, Cursor Local, and Muse workers need:

- Linux with a working `systemd --user` manager
- `systemd-run` 244 or newer and unified cgroup v2
- Node.js 24+
- Python 3.11+ for bundled setup
- A current Codex CLI with plugin support

Cursor Cloud runs remotely and does not need that local process boundary.

Follow
[install and authentication](../README.md#install-and-authentication).
Bundled setup may install **shared** package prerequisites. Authenticate only
the **one** provider you plan to use first. Do not assume setup installs
providers selectively.

Start a **new** Codex session after the plugin add. Any extra Co-Engineer
panel is optional, feature-detected, and host-specific. If this host has no
panel, keep talking in Codex CLI. That headless path is complete.

## 2. One useful first outcome

From a source clone, copy `examples/first-outcome` into a clean Git
repository (see that folder's README). Then ask Codex with your chosen
provider:

> Use Grok Co-Engineer to implement `lib/summarize-checks.cjs` so
> `node summarize-checks.mjs` summarizes named check JSON (passed / failed /
> skipped counts and failure names) and make the frozen `node check.mjs`
> pass without editing the checker. Commit the result.

Replace Grok with Cursor or Muse when that is your provider. Acceptance is
local and deterministic: `node check.mjs`. No MCP payloads.

## 3. Delegate one assignment

You:

> Delegating to Co-Engineer: review the auth change with Grok Co-Engineer.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Co-Engineer is preparing 1 independent assignment.

After admission and authoritative prompt dispatch, the run card may change
that phrase to `Co-Engineer is running 1 independent assignment`.

Codex waits once. When the work is complete, Codex inspects it:

> Co-Engineer finished, and I verified the candidate.

You still decide whether to keep, change, or discard the result. That
sentence is Codex's review, not a merge, push, or pull request.

## 4. Independent assignments and review order

Independent means the assignments do not share a writer path. The bound is
eight. This is still one bounded run and one coordinated wait.

You:

> Split this into three isolated independent assignments: API
> validation, the operator guide, and a review of both diffs.

Codex:

> I am delegating this to Co-Engineer. Co-Engineer is preparing 3
> independent assignments.

The first card says `preparing` until every required lane has authoritative
prompt-dispatch evidence; only then does it say `running`.

Name co-engineers when you care which route takes which assignment:

> Use Grok Co-Engineer for the API change and Muse Co-Engineer for the
> docs. Keep the review on Cursor Co-Engineer.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Using Muse Co-Engineer. Using Cursor Co-Engineer. Co-Engineer is
> preparing 3 assignments.

For multi-provider recipes, **review the resulting immutable candidate**. Do
not run a dependent review concurrently against the shared base while writers
are still producing it.

Provider preferences on a run request reuse ownership **for that request** by
role. Exact assignment provider or model choices win. Preferences are not
saved global Codex settings.

## 5. Ask once when nothing is named

If you want a team and have no named co-engineers on the request:

You:

> Give Codex a team of external co-engineers without giving up control.
> Split the validator and the docs.

Codex asks once which co-engineers should take the independent
assignments: Grok, Cursor, or Muse. It does not keep asking and does not
invent a default router.

You:

> Grok for the validator. Muse for the docs.

Codex:

> I am delegating this to Co-Engineer. Using Grok Co-Engineer.
> Using Muse Co-Engineer. Co-Engineer is preparing 2 assignments.

## 6. Chat, correct, or cancel

`Chatting with Co-Engineer` manages an existing assignment: inspect,
continue, answer grouped attention, or cancel. Unrelated new work needs an
explicit new delegation, not chat.

If Codex groups questions from more than one assignment:

> Co-Engineer needs one decision from you.

Answer once. That is not a second delegation.

To correct a **completed** candidate, ask Codex to return bounded findings to
the same external owner. That uses a fresh scoped `task.revision`, not a
terminal `run_reply`. `run_reply` is for pending questions or consent only.

If a required assignment fails or stays unresolved, Codex does not say
Co-Engineer finished, and I verified the candidate. You may cancel:

> Chatting with Co-Engineer: cancel that run.

## What success looks like

The honest shape is up to eight isolated external co-engineers, one
bounded run, one coordinated wait, one verified decision.

The public MCP catalog remains five tools: `status`, `delegate`, `task`,
`tasks`, and `cancel`. Codex remains chief engineer and reviewer.
External workers may commit within their assigned scope. Publication and merge require user authorization and Codex review.
Review exact commit and tree identities, verification results, and current CI
before integration. The user retains version, tag, release, and protected-ref authority.

Next:

- [Troubleshooting](co-engineer-troubleshooting.md)
- [3.2.1 migration](co-engineer-migration-3.2.1.md)
- [Configuration](configuration.md)
