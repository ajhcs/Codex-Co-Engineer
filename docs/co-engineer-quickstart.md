# Co-Engineer quickstart

Give Codex a team of external co-engineers without giving up control.

This is the 60-second path after
[install and authentication](../README.md#install-and-authentication).
Speak in ordinary language. You do not write tool payloads.

Start a **new** Codex session after the plugin add. Any extra Co-Engineer
panel is optional, feature-detected, and host-specific. If this host has
no panel, keep talking in Codex CLI. That headless path is complete.

## Delegate one assignment

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

## Delegate several independent assignments

Independent means the assignments do not share a writer path. The bound
is eight. This is still one bounded run and one coordinated wait.

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

## Ask once when nothing is named

If you want a team and have no saved profile and no named co-engineers:

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

## Chat with existing work

`Chatting with Co-Engineer` never starts a run. It inspects, continues,
answers grouped attention, or cancels work that already exists.

If Codex groups questions from more than one assignment:

> Co-Engineer needs one decision from you.

Answer once. That is not a second delegation.

If a required assignment fails or stays unresolved, Codex does not say
Co-Engineer finished, and I verified the candidate. You may cancel:

> Chatting with Co-Engineer: cancel that run.

## What success looks like

The honest shape is up to eight isolated external co-engineers, one
bounded run, one coordinated wait, one verified decision.

Codex remains chief engineer. You remain merge authority.

Next:

- [Troubleshooting](co-engineer-troubleshooting.md)
- [3.2.1 migration](co-engineer-migration-3.2.1.md)
- [Configuration](configuration.md)
