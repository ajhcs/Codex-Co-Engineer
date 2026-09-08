# Co-Engineer user journeys

Give Codex a team of external co-engineers without giving up control.

These are the normal-user journeys later UX slices consume. Every step is
public language. Users never write tool payloads. Users never see internal
plumbing names.

Delegating to Co-Engineer starts one bounded run. Chatting with
Co-Engineer inspects, continues, answers grouped attention, or cancels
that existing run. Codex keeps control. The honest shape is
up to eight isolated external co-engineers, one bounded run, one coordinated wait, one verified decision.

## One-lane

The user wants one isolated assignment.

User: Review the auth change with Grok Co-Engineer.

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer.
Co-Engineer is preparing 1 independent assignment.

After every required lane has authoritative prompt-dispatch evidence, the
run card may say that Co-Engineer is running 1 independent assignment.

Codex waits once. When the work is complete, Codex inspects it.

Codex: Co-Engineer finished, and I verified the candidate.

The user still decides whether to keep, change, or discard the result.
This is one submission, one coordinated wait, and one verified
decision.

## Multi-lane

The user wants several independent assignments in one run.

User: Split this into three isolated independent assignments: API
validation, the operator guide, and a review of both diffs.

Codex: I am delegating this to Co-Engineer. Co-Engineer is preparing 3
independent assignments.

Only after all three required lanes have authoritative prompt-dispatch
evidence does the run card say that Co-Engineer is running 3 independent
assignments.

Codex does not start three separate runs and does not poll each
assignment. One coordinated wait covers the whole run. Independent
means the assignments do not share a writer path. The bound is eight.

When the run completes, Codex inspects the combined result before any
integration.

Codex: Co-Engineer finished, and I verified the candidate.

## Grouped-attention

Chatting with Co-Engineer during a live run.

The run is already in its one coordinated wait. More than one
assignment needs a choice. Codex groups those questions into one
decision. Unaffected assignments keep working.

Codex: Co-Engineer needs one decision from you.

User: Use the stricter validator and keep the docs change as written.

That answer is chatting: answer grouped attention. It is not a second
delegation and not a debate loop. Codex continues the same run with the
same single wait. After the run completes, Codex still verifies before
the user integrates anything.

## Verified-final

The success close for every complete run.

After the one coordinated wait, Codex inspects the candidate. Only then
may it say:

Co-Engineer finished, and I verified the candidate.

Verification is Codex's review of the candidate, not itself a merge.
External workers may commit. A scoped publisher may non-force push only
the task branch and open a draft PR. Codex remains the merge authority
and may merge only after exact-head, current-green-CI, and topology checks
and the user's authorization. The user retains release, tag, version,
and protected-ref authority. Downstream slices must not treat the
sentence as a completed merge.

## Failure/unresolved

A required assignment fails, cannot be answered, or stays unresolved.

User: Continue the running Co-Engineer work.

Codex inspects and reports the outcome honestly. It does not say
Co-Engineer finished, and I verified the candidate. A required gap
blocks a complete candidate. Codex does not invent success, repair the
lane in secret, or open a second run to hide the failure.

The user may cancel the run or decide what to do next. Cancel is
chatting with Co-Engineer, not a new delegation.

## Provider-choice

The user chooses which co-engineers to use.

User: Use Grok Co-Engineer for the API change and Muse Co-Engineer for
the docs. Keep the review on Cursor Co-Engineer.

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer.
Using Muse Co-Engineer. Using Cursor Co-Engineer. Co-Engineer is
preparing 3 independent assignments.

The card changes to running only after all three required lanes have
authoritative prompt-dispatch evidence.

Codex does not pick co-engineers by cost, speed, or a hidden router.
Cursor on this computer and Cursor Cloud both stay Using Cursor
Co-Engineer in public speech. The user may name the Cursor place in
plain language; Codex still does not expose internal slot names.

## No-profile ask-once

The user wants a team and has no saved profile and no named
co-engineers.

User: Give Codex a team of external co-engineers without giving up
control. Split the validator and the docs.

Codex asks once which co-engineers should take the independent
assignments: Grok, Cursor, or Muse. It does not keep asking, does not
invent a default router, and does not submit before the choice exists.

User: Grok for the validator. Muse for the docs.

Codex: I am delegating this to Co-Engineer. Using Grok Co-Engineer.
Using Muse Co-Engineer. Co-Engineer is preparing 2 independent
assignments.

After dispatch evidence is authoritative for both required lanes, the
card may say that Co-Engineer is running 2 independent assignments.

That is still one submission and one coordinated wait. The ask happens
before delegation. Afterward, chatting with Co-Engineer can inspect,
continue, answer grouped attention, or cancel.

## Optional legacy host relay

The public phrases stay Delegating to Co-Engineer and Chatting with
Co-Engineer. Ordinary delegation stays in the current Codex task and uses
the user's selected model. Luna Max becomes project manager for a run only
when the user explicitly requests the legacy relay, authorizes a pinned
task, Luna Max is available, and the host can create a thread, send a
message to that thread, and wait on or read it.

User: Delegating to Co-Engineer: pin Luna Max as the project manager
for this isolated review.

Codex: I am delegating this to Co-Engineer. Luna Max is the project
manager for this Co-Engineer run. Co-Engineer is running 1 independent
assignment.

That is still one submission and one coordinated wait. Luna Max wakes
when the work is completed, blocked, failed, asking a question, timed
out, or carrying a user update. Routine progress does not wake it.
Normal completion does not wake Sol. When the work is publication-ready
and exact head, tree, verifier, current green CI, and topology facts
pass, the optional relay may notify Sol High or Sol XHigh once only when
the user explicitly selected that target. The notification does not
grant merge or release authority.

If Luna Max or those host task tools are missing, Codex continues in
this conversation and says so. It does not substitute Sol.

## Control retained

Across every journey:

- Codex remains the chief engineer and reviewer.
- External workers may commit. A scoped publisher may non-force push
  only the task branch and open a draft pull request. Luna Max does
  not merge. Codex remains the merge authority and may merge only after
  exact-head, current-green-CI, and topology checks and the user's
  authorization. The user retains release, tag, version, and
  protected-ref authority.
- External co-engineers stay isolated.
- One bounded run is in flight at a time for this work.
- Chatting never becomes a second submission.
- Failure stays visible.

## Non-goals

These journeys do not teach tool payloads, internal plumbing, extra
speed, lower credits, a universal interface, or automatic routing. They
do not add a sixth tool or a second wait loop.
