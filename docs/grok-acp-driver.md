# Grok ACP driver question bridge

Status: implemented against the accepted P17 driver contract and the live
ACP worker. Not live-transport qualification.

Grok advertises `same_session_reply: live_session_reply`. That posture is
honest only when a structured Co-Engineer question bridge exists.

## Structured bridge

Grok's same-session A/B question is `ask_user_question`. Co-Engineer
latches `needs_attention` only from a live `session_id` and `question_id`:

- live ACP form elicitation (`elicitation/create`) and user-facing
  `session/request_permission` for that tool identity
- one mailbox reply that resumes the exact ACP session once
- P18 `submitGrokAcpAttentionReplyV1` on the injected transport `reply`
  operation, attempt-once, bound to the exact session and question

Missing identity, unconfirmed delivery, or a completed observe after
`ask_user_question` was structurally unsupported fail closed. The lane is
never replayed as a new prompt.

## False-success closure

The observed 3.4.0 transcript — Grok reports `ask_user_question`
unsupported, emits the unanswered question as ordinary result text, ends,
and Co-Engineer stored `completed` with `question_id` null — is preserved
as a negative fixture. Projection must not report `succeeded`. Detection
uses the structured tool identity and the live question id, not semantic
guessing from arbitrary prose. A successful result that merely quotes the
phrase remains `succeeded`.

Owned files:

- `plugins/codex-co-engineer/mcp/v3/grok-acp-driver.mjs`
- `plugins/codex-co-engineer/mcp/v3/grok-question-bridge.mjs`
- `plugins/codex-co-engineer/mcp/v3/acp-worker.mjs`
- `plugins/codex-co-engineer/mcp/v3/supervisor.mjs`
- this document
