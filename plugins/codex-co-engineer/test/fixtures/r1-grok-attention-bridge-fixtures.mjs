import {
  ASK_USER_QUESTION_TOOL,
  OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT,
} from '../../mcp/v3/grok-question-bridge.mjs';
import { terminalReceipt } from './r1-supervisor-result-truthfulness-fixtures.mjs';

export { ASK_USER_QUESTION_TOOL, OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT };

export const OBSERVED_UNSUPPORTED_QUESTION_EVENT = Object.freeze({
  type: 'tool_call',
  title: ASK_USER_QUESTION_TOOL,
  toolCallId: ASK_USER_QUESTION_TOOL,
  status: 'failed',
  text: 'ask_user_question (failed): unsupported',
});

export function observedUnsupportedQuestionReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-grok-unsupported-question',
    provider: 'grok',
    result: OBSERVED_UNSUPPORTED_QUESTION_TRANSCRIPT,
    error: null,
    attention: { session_id: 'sess-live-grok', question_id: null },
    last_event: OBSERVED_UNSUPPORTED_QUESTION_EVENT,
    question_bridge: 'unavailable',
    ...overrides,
  });
}

export function quotedUnsupportedQuestionInSuccessfulResultReceipt(overrides = {}) {
  return terminalReceipt({
    id: 'rtruth-quoted-unsupported-question',
    provider: 'grok',
    result: [
      'Review notes:',
      '- the agent quoted "I will not continue until answered" from an older log',
      '- the requested implementation is complete',
    ].join('\n'),
    error: null,
    last_event: { type: 'text_delta', text: 'the requested implementation is complete' },
    ...overrides,
  });
}

export function missingQuestionIdentityObserve(identity) {
  return {
    status: 'needs_attention',
    session_id: identity.session_id,
    ...identity.fields,
  };
}

export function unsupportedQuestionCompletedObserve(identity) {
  return {
    status: 'completed',
    session_id: identity.session_id,
    ...identity.fields,
    events: [OBSERVED_UNSUPPORTED_QUESTION_EVENT],
  };
}
